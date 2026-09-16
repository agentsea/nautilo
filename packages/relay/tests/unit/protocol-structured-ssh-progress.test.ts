import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { RelayDispatchRequest, RelaySshDispatchBindingV1 } from "../../src/protocol";
import type { RelayCapabilities } from "../../src/types";

const RS_OPEN = 1;
const RS_CLOSED = 3;
class MockRelayWebSocket {
  static OPEN = RS_OPEN;
  static CONNECTING = 0;
  static CLOSED = RS_CLOSED;
  readyState = MockRelayWebSocket.CONNECTING;
  sent: string[] = [];
  private readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  constructor(_url: string) {}
  on(event: string, handler: (...args: unknown[]) => void): this {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    return this;
  }
  send(data: string): void { this.sent.push(data); }
  close(): void { this.readyState = RS_CLOSED; }
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
    constructor(url: string) { super(url); created.push(this); }
  },
}));

const { createRelayClient } = await import("../../src/client");
const capabilities: RelayCapabilities = { profile: "desktop-agent", canRunShell: true };
const binding: RelaySshDispatchBindingV1 = {
  version: 2,
  admissionId: "admission-1",
  toolCallId: "tool-call-1",
  approvedRequestDigest: "a".repeat(64),
  operation: "exec",
  preparationId: "preparation-1",
  subject: {
    userId: "user-1", actorId: "actor-1", actorRole: "owner", agentId: "agent-1",
    executionEntrypoint: "foreground.main", instanceId: "instance-1", relayId: "relay-1",
    relaySessionId: "relay-session-1", desktopSessionId: "desktop-1", pairingGenerationRef: "pairing-1", capabilityRevision: 1,
  },
};

beforeEach(() => { created.length = 0; });
afterEach(() => { created.length = 0; });

async function connected(protocolVersion: number, onDispatch: (request: RelayDispatchRequest) => Promise<void>) {
  const client = createRelayClient({
    serverUrl: "http://127.0.0.1:9", userId: "user-1", relayId: "relay-1", desktopSessionId: "desktop-1",
    initialCapabilityRevision: 1, capabilities,
    onDispatch: async (request) => { await onDispatch(request); return { status: "ok" }; },
  });
  const connectPromise = client.connect();
  const ws = created.at(-1)!;
  ws.triggerOpen();
  ws.triggerMessage(JSON.stringify({
    type: "relay:registered", relayId: "relay-1", protocolVersion,
    selectedProtocolVersion: protocolVersion, relaySessionId: "relay-session-1", pairingGenerationRef: "pairing-1",
  }));
  await connectPromise;
  return { client, ws };
}

describe("D500 v15 structured SSH progress protocol", () => {
  test("emits bounded observations only for a negotiated structured SSH dispatch", async () => {
    let callback: RelayDispatchRequest["reportStructuredSshProgress"];
    const { client, ws } = await connected(15, async (request) => { callback = request.reportStructuredSshProgress; });
    ws.triggerMessage(JSON.stringify({
      type: "relay:dispatch", correlationId: "corr-ssh", toolName: "ssh", args: { operation: "exec" },
      impact: "high", approvalObtained: true, executionClass: "structured-ssh", sshBinding: binding,
    }));
    await Bun.sleep(10);
    expect(callback).toBeDefined();
    callback!({
      version: 1, sequence: 0, operation: "exec", kind: "exec-output", stream: "stdout", offsetBytes: 0, endOffsetBytes: 2,
      text: "ok", elapsedMs: 1, phase: "running",
    });
    // An exec preparation cannot turn into a copy stream after dispatch.
    callback!({ version: 1, sequence: 1, operation: "copy-upload", kind: "transfer", phase: "starting", transferredBytes: 0, elapsedMs: 2 });
    const frames: Array<Record<string, unknown>> = ws.sent.map((raw) => {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("expected object relay frame");
      return parsed as Record<string, unknown>;
    });
    const progressFrames = frames.filter((frame) => frame["type"] === "relay:structured-ssh-progress");
    expect(progressFrames).toHaveLength(1);
    expect(progressFrames[0]).toMatchObject({ correlationId: "corr-ssh", kind: "exec-output", text: "ok" });
    await client.disconnect();
  });

  test("does not install the SSH reporter for legacy peers or raw shell", async () => {
    let legacyReporter: RelayDispatchRequest["reportStructuredSshProgress"];
    const legacy = await connected(14, async (request) => { legacyReporter = request.reportStructuredSshProgress; });
    legacy.ws.triggerMessage(JSON.stringify({
      type: "relay:dispatch", correlationId: "corr-old", toolName: "ssh", args: { operation: "exec" },
      impact: "high", approvalObtained: true, executionClass: "structured-ssh", sshBinding: binding,
    }));
    await Bun.sleep(10);
    expect(legacyReporter).toBeUndefined();
    await legacy.client.disconnect();

    let shellReporter: RelayDispatchRequest["reportStructuredSshProgress"];
    let authReporter: RelayDispatchRequest["reportStructuredSshProgress"];
    const modern = await connected(15, async (request) => {
      if (request.correlationId === "corr-auth") authReporter = request.reportStructuredSshProgress;
      else shellReporter = request.reportStructuredSshProgress;
    });
    modern.ws.triggerMessage(JSON.stringify({
      type: "relay:dispatch", correlationId: "corr-shell", toolName: "run_shell", args: { command: "echo hi" },
      impact: "low", approvalObtained: true,
    }));
    modern.ws.triggerMessage(JSON.stringify({
      type: "relay:dispatch", correlationId: "corr-auth", toolName: "ssh", args: { operation: "auth" },
      impact: "low", approvalObtained: true, executionClass: "structured-ssh", sshBinding: { ...binding, operation: "auth" },
    }));
    await Bun.sleep(10);
    expect(shellReporter).toBeUndefined();
    expect(authReporter).toBeUndefined();
    await modern.client.disconnect();
  });
});
