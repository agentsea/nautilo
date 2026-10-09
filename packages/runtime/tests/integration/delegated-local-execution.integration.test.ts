import { expect, test } from "bun:test";
import type { RelayLocalExecutionBindingV4, RelayServerMessage } from "@nautilo/relay";
import { InMemoryRelayRegistry } from "../../src/relay-registry";

async function fixture() {
  const registry = new InMemoryRelayRegistry();
  const sent: RelayServerMessage[] = [];
  const capabilities = { profile: "desktop-agent" as const, canExecuteLocal: true, canDelegateLocalExecution: true,
    localExecution: { version: 1 as const, generation: "host", pipe: true as const, pty: true, capacity: 2 } };
  await registry.register("relay", "human", capabilities, message => {
    sent.push(message);
    if (message.type === "relay:dispatch") registry.resolveDispatch(message.correlationId,
      { status: "ok", result: { session_id: "execution", state: "running", resources: "owned" } });
  }, 28, "desktop", 1, "raw-pair");
  const binding: RelayLocalExecutionBindingV4 = { version: 4, generation: "host", invocationId: "call", executionId: "execution", operation: "start",
    authority: { kind: "delegated", taskId: "task", taskRunId: "run", roomId: "room", delegation: {
      version: 1, humanUserId: "human", agentId: "agent", sourceRoomId: "source", sourceConversationId: "source-thread", rootTaskId: "task",
      target: { instanceId: "", relayId: "relay", pairingGeneration: "raw-pair", serverOrigin: "https://server.invalid", serverFingerprint: "fingerprint" },
      projectGrantId: "grant", ceiling: "basic", profile: null } },
    owner: { instanceId: "", humanUserId: "human", agentId: "agent", runId: "run", conversationId: "thread",
      relayId: "relay", desktopSessionId: "desktop", pairingGeneration: registry.getLocalExecutionPairingGeneration("relay")!, serverBindingId: "server",
      profileId: null, profileRevision: null, grantIds: ["grant"], grantRevision: null, protectedPolicyVersion: 1 } };
  let references = 0;
  const source = new AbortController();
  const request = { toolName: "exec_command", impact: "destructive" as const, approvalObtained: true, args: { cmd: "work" }, localExecutionBinding: binding, signal: source.signal,
    retainLocalExecutionSource: () => { references++; let released = false; return () => { if (!released) { released = true; references--; } }; } };
  return { registry, capabilities, sent, binding, source, request, references: () => references };
}

test("yielded delegated record retains its source until confirmed resource release", async () => {
  const f = await fixture(); await f.registry.dispatch("relay", f.request);
  expect(f.references()).toBe(1);
  f.source.abort();
  expect(f.sent.at(-1)).toMatchObject({ type: "relay:dispatch", args: { session_id: "execution", cancel: true } });
  expect(f.references()).toBe(1);
  await f.registry.unregister("relay");
  await f.registry.register("relay", "human", f.capabilities, message => {
    if (message.type === "relay:dispatch") f.registry.resolveDispatch(message.correlationId,
      { status: "ok", result: { state: "cancelled", resources: "released" } });
  }, 28, "desktop", 2, "raw-pair");
  await f.registry.dispatch("relay", { toolName: "write_stdin", impact: "read-only", approvalObtained: false, args: { session_id: "execution" }, localExecutionBinding: { ...f.binding, operation: "read" } });
  expect(f.references()).toBe(0);
});

test("offline queued cancellation survives delegated capability reduction on the same generation", async () => {
  const f = await fixture(); await f.registry.dispatch("relay", f.request); await f.registry.unregister("relay");
  f.source.abort();
  let resolveCancel!: () => void;
  const cancelled = new Promise<void>(resolve => { resolveCancel = resolve; });
  const sent: RelayServerMessage[] = [];
  await f.registry.register("relay", "human", { ...f.capabilities, canExecuteLocal: false, canDelegateLocalExecution: false }, message => {
    sent.push(message);
    if (message.type === "relay:dispatch") {
      f.registry.resolveDispatch(message.correlationId, { status: "ok", result: { state: "cancelled", resources: "released" } });
      resolveCancel();
    }
  }, 28, "desktop", 2, "raw-pair");
  await cancelled;
  expect(sent.find(message => message.type === "relay:dispatch")).toMatchObject({ type: "relay:dispatch", args: { session_id: "execution", cancel: true },
    localExecutionBinding: { version: 4, authority: { taskRunId: "run" } } });
  // Fire-and-forget cleanup is not a confirmed receipt. Keep the record until
  // a checked result or an explicitly different host generation retires it.
  expect(f.references()).toBe(1);
  await f.registry.unregister("relay");
  await f.registry.register("relay", "human", { ...f.capabilities, localExecution: { ...f.capabilities.localExecution, generation: "replacement" } },
    () => {}, 28, "desktop", 3, "raw-pair");
  expect(f.references()).toBe(0);
});
