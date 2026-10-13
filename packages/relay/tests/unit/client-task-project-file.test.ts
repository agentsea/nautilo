import { describe, expect, mock, test } from "bun:test";
import type { RelayDispatchRequest, RelayLocalExecutionBindingV4 } from "../../src/protocol";

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
const binding: RelayLocalExecutionBindingV4 = {
  version: 4, generation: "generation", invocationId: "call", executionId: "execution", operation: "read",
  owner: { instanceId: "instance-fixture", humanUserId: "human", agentId: "agent", runId: "10000000-0000-4000-8000-000000000001", conversationId: "task-thread",
    relayId: "relay", desktopSessionId: "desktop", pairingGeneration: "wire-pairing", serverBindingId: "server",
    profileId: null, profileRevision: null, grantIds: ["project-grant"], grantRevision: null, protectedPolicyVersion: 1 },
  authority: { kind: "delegated", taskId: "task", taskRunId: "10000000-0000-4000-8000-000000000001", roomId: "task-room", delegation: {
    version: 1, humanUserId: "human", agentId: "agent", sourceRoomId: "source-room", sourceConversationId: "source-thread",
    rootTaskId: "task", projectGrantId: "project-grant", ceiling: "basic", profile: null,
    target: { instanceId: "instance-fixture", relayId: "relay", pairingGeneration: "raw-pairing", serverOrigin: "https://server.example", serverFingerprint: "fingerprint" },
  } },
};

const root = `/projects/root/nautilo-repo-docs/task-run-${binding.authority.taskRunId}`;
async function fixture(protocolVersion = 30) {
  const dispatched: { request: RelayDispatchRequest; signal: AbortSignal; finish(): void }[] = [];
  const client = createRelayClient({ serverUrl: "http://127.0.0.1:9", userId: binding.owner.humanUserId,
    relayId: binding.owner.relayId, desktopSessionId: binding.owner.desktopSessionId, runShellOwnerInstanceId: binding.owner.instanceId,
    capabilities: { profile: "desktop-agent", localFileExecution: true, canUseTaskProjectFiles: true,
      canDelegateLocalExecution: true, canExecuteLocal: true,
      localExecution: { version: 1, generation: binding.generation, pipe: true, pty: true, capacity: 8, localNetworkPolicy: true } },
    initialCapabilityRevision: 1, reconnectDelayMs: 30000,
    onDispatch: (request, signal) => new Promise(resolve => { dispatched.push({ request, signal,
      finish: () => resolve({ status: "ok", result: { ok: true, result: "fixture" } }) }); }),
  });
  const connecting = client.connect(); const socket = sockets.at(-1)!; socket.open();
  socket.message({ type: "relay:registered", relayId: binding.owner.relayId, protocolVersion,
    selectedProtocolVersion: protocolVersion, relaySessionId: "relay-session-fixture", pairingGenerationRef: binding.owner.pairingGeneration });
  await connecting;
  const dispatch = (overrides: Record<string, unknown> = {}) => socket.message({ type: "relay:dispatch", correlationId: "rpc-fixture",
    toolName: "local-file", executionClass: "local-file", impact: "read-only", approvalObtained: false,
    args: { operation: { kind: "file", command: "read", zone: "current", args: { path: "wiki/index.md" } }, allowedRoots: [root] },
    localExecutionBinding: binding, ...overrides });
  return { client, socket, dispatched, dispatch, cleanup: async () => { for (const entry of dispatched) entry.finish(); await client.disconnect(); } };
}
describe("Task project file transport admission and lifetime", () => {
  test("accepts current V4 file calls and keeps ordinary socket cancellation ownership", async () => {
    const f = await fixture();
    try {
      f.dispatch(); expect(f.dispatched).toHaveLength(1);
      expect(f.dispatched[0]!.request.runShellOwnerBinding).toMatchObject({ userId: binding.owner.humanUserId, relayId: binding.owner.relayId });
      f.socket.close(1006); expect(f.dispatched[0]!.signal.aborted).toBe(true);
    } finally { await f.cleanup(); }
  });
  test("an exact cancellation aborts a pending file operation", async () => {
    const f = await fixture();
    try { f.dispatch(); f.socket.message({ type: "relay:cancel", correlationId: "foreign" });
      expect(f.dispatched[0]!.signal.aborted).toBe(false);
      f.socket.message({ type: "relay:cancel", correlationId: "rpc-fixture" }); expect(f.dispatched[0]!.signal.aborted).toBe(true);
    } finally { await f.cleanup(); }
  });
  test("older negotiation rejects Task calls while ordinary local-file dispatch remains usable", async () => {
    const f = await fixture(29);
    try { f.dispatch(); expect(f.dispatched).toHaveLength(0);
      expect(f.socket.sent.map(raw => JSON.parse(raw) as { errorCode?: string }).some(m => m.errorCode === "TASK_PROJECT_FILE_UNAVAILABLE")).toBe(true);
      f.dispatch({ localExecutionBinding: undefined }); expect(f.dispatched).toHaveLength(1);
    } finally { await f.cleanup(); }
  });
  test("changed owner/generation and parallel grant envelopes never reach Desktop", async () => {
    const f = await fixture();
    try {
      for (const value of [ { ...binding, generation: "other" }, { ...binding, owner: { ...binding.owner, humanUserId: "other" } } ])
        f.dispatch({ localExecutionBinding: value });
      f.dispatch({ desktopFilesystemGrantRequest: {} }); f.dispatch({ hostedBy: binding.owner.relayId });
      expect(f.dispatched).toHaveLength(0);
    } finally { await f.cleanup(); }
  });
});
