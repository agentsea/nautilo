import { describe, expect, mock, test } from "bun:test";
import type { RelayDispatchRequest, RelayLocalExecutionBindingV1 } from "../../src/protocol";
import { RELAY_AUTHENTICATION_REQUIRED_ERROR_CODE, RELAY_TOKEN_AUTH_CLOSE_CODE } from "../../src/constants";

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readyState = FakeSocket.CONNECTING;
  readonly sent: string[] = [];
  private readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  constructor(_url: string) {}
  on(event: string, handler: (...args: unknown[]) => void) {
    this.handlers.set(event, [...this.handlers.get(event) ?? [], handler]); return this;
  }
  send(data: string) { this.sent.push(data); }
  open() { this.readyState = FakeSocket.OPEN; this.emit("open"); }
  message(value: unknown) { this.emit("message", JSON.stringify(value)); }
  close(code = 1000) { this.readyState = FakeSocket.CLOSED; this.emit("close", code); }
  terminate() { this.close(1006); }
  private emit(event: string, ...args: unknown[]) { for (const handler of this.handlers.get(event) ?? []) handler(...args); }
}
const sockets: FakeSocket[] = [];
mock.module("ws", () => ({ default: class extends FakeSocket {
  constructor(url: string) { super(url); sockets.push(this); }
} }));
const { createRelayClient } = await import("../../src/client");
const binding: RelayLocalExecutionBindingV1 = { version: 1, generation: "generation-fixture", executionId: "execution-fixture",
  invocationId: "call-fixture", operation: "start", owner: { instanceId: "instance-fixture", humanUserId: "human-fixture",
    agentId: "agent-fixture", runId: "run-fixture", conversationId: "conversation-fixture", relayId: "relay-fixture",
    desktopSessionId: "desktop-fixture", pairingGeneration: "pairing-fixture", serverBindingId: "server-fixture",
    profileId: "profile-fixture", profileRevision: 1, grantIds: [], grantRevision: 1, protectedPolicyVersion: 1 } };
async function fixture() {
  const dispatched: { request: RelayDispatchRequest; signal: AbortSignal; finish: () => void }[] = [];
  const client = createRelayClient({ serverUrl: "http://127.0.0.1:9", userId: binding.owner.humanUserId,
    relayId: binding.owner.relayId, desktopSessionId: binding.owner.desktopSessionId, runShellOwnerInstanceId: binding.owner.instanceId,
    capabilities: { profile: "desktop-agent", canExecuteLocal: true, canRunShell: true,
      localExecution: { version: 1, generation: binding.generation, pipe: true, pty: true, capacity: 8 } },
    initialCapabilityRevision: 1, reconnectDelayMs: 30000,
    onDispatch: (request, signal) => new Promise(resolve => { dispatched.push({ request, signal,
      finish: () => resolve({ status: "ok", result: { state: "running", resources: "owned" } }) }); }),
  });
  const connect = async () => {
    const connecting = client.connect(); const socket = sockets.at(-1)!; socket.open();
    socket.message({ type: "relay:registered", relayId: binding.owner.relayId, protocolVersion: 20,
      selectedProtocolVersion: 20, relaySessionId: "relay-session-fixture", pairingGenerationRef: binding.owner.pairingGeneration });
    await connecting; return socket;
  };
  const socket = await connect();
  const dispatch = (overrides: Record<string, unknown> = {}) => socket.message({ type: "relay:dispatch", correlationId: "rpc-fixture",
    toolName: "exec_command", args: { cmd: "echo fixture" }, impact: "destructive", approvalObtained: true,
    localExecutionBinding: binding, ...overrides });
  const cleanup = async () => { for (const entry of dispatched) entry.finish(); await client.disconnect(); };
  return { client, socket, dispatched, dispatch, connect, cleanup };
}

describe("managed execution transport lifetime", () => {
  test("ordinary loss preserves validated managed start while ordinary shell work aborts", async () => {
    const f = await fixture();
    try {
      f.dispatch(); f.dispatch({ toolName: "run_shell", localExecutionBinding: undefined, args: { command: "echo fixture" }, correlationId: "legacy-rpc" });
      expect(f.dispatched).toHaveLength(2);
      f.socket.close(1006);
      expect(f.dispatched[0]!.signal.aborted).toBe(false);
      expect(f.dispatched[1]!.signal.aborted).toBe(true);
      f.dispatched[0]!.finish(); await Promise.resolve();
      expect(f.dispatched[0]!.signal.aborted).toBe(false);
    } finally { await f.cleanup(); }
  });
  test("explicit disconnect still aborts a start retained through ordinary loss", async () => {
    const f = await fixture();
    try { f.dispatch(); f.socket.close(1006); await f.client.disconnect(); expect(f.dispatched[0]!.signal.aborted).toBe(true); }
    finally { await f.cleanup(); }
  });
  test("exact relay cancellation after coherent reconnect reaches the original pending start", async () => {
    const f = await fixture();
    try {
      f.dispatch(); f.socket.close(1006); const replacement = await f.connect();
      replacement.message({ type: "relay:cancel", correlationId: "foreign-rpc" });
      expect(f.dispatched[0]!.signal.aborted).toBe(false);
      replacement.message({ type: "relay:cancel", correlationId: "rpc-fixture" });
      expect(f.dispatched[0]!.signal.aborted).toBe(true);
    } finally { await f.cleanup(); }
  });
  test("token revocation and authenticated authority-loss frame abort managed starts", async () => {
    for (const method of ["close", "frame"] as const) {
      const f = await fixture();
      try {
        f.dispatch();
        if (method === "close") f.socket.close(RELAY_TOKEN_AUTH_CLOSE_CODE);
        else f.socket.message({ type: "relay:error", message: "Authentication required", code: RELAY_AUTHENTICATION_REQUIRED_ERROR_CODE });
        expect(f.dispatched[0]!.signal.aborted).toBe(true);
      } finally { await f.cleanup(); }
    }
  });
  test("only exact validated built-in bindings enter the managed exception", async () => {
    const f = await fixture();
    try {
      const invalid = [
        { localExecutionBinding: { ...binding, owner: { ...binding.owner, humanUserId: "foreign-human" } } },
        { localExecutionBinding: { ...binding, generation: "foreign-generation" } },
        { hostedBy: binding.owner.relayId },
        { toolName: "unknown", args: { session_id: binding.executionId }, localExecutionBinding: { ...binding, operation: "read" } },
      ];
      for (const overrides of invalid) f.dispatch(overrides);
      expect(f.dispatched).toHaveLength(0);
      expect(f.socket.sent.map(raw => JSON.parse(raw) as { errorCode?: string }).filter(m => m.errorCode === "LOCAL_EXECUTION_BINDING_INVALID")).toHaveLength(invalid.length);
    } finally { await f.cleanup(); }
  });
  test("an old reply cannot detach a replacement RPC using the same correlation", async () => {
    const f = await fixture();
    try {
      f.dispatch(); f.socket.close(1006); const replacement = await f.connect();
      replacement.message({ type: "relay:dispatch", correlationId: "rpc-fixture", toolName: "exec_command",
        args: { cmd: "echo fixture" }, localExecutionBinding: binding, impact: "destructive", approvalObtained: true });
      expect(f.dispatched).toHaveLength(2); f.dispatched[0]!.finish(); await Promise.resolve();
      replacement.message({ type: "relay:cancel", correlationId: "rpc-fixture" });
      expect(f.dispatched[1]!.signal.aborted).toBe(true);
    } finally { await f.cleanup(); }
  });
});
