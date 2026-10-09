import { expect, test } from "bun:test";
import type { RelayLocalExecutionBindingV3, RelayServerMessage } from "@nautilo/relay";
import { InMemoryRelayRegistry } from "../../src/relay-registry";
async function fixture(protocol = 29, finished = false, holdStart = false) {
  const registry = new InMemoryRelayRegistry(); const sent: RelayServerMessage[] = [];
  await registry.register("relay", "human", { profile: "desktop-agent", canExecuteLocal: true, canExecuteFullMacOneShot: true,
    localExecution: { version: 1, generation: "host", pipe: true, pty: true, localNetworkPolicy: true, capacity: 2 } }, message => {
    sent.push(message); if (message.type === "relay:dispatch" && !(holdStart && message.toolName === "exec_command")) registry.resolveDispatch(message.correlationId,
      { status: "ok", result: { session_id: "execution", state: finished ? "completed" : "running", resources: finished ? "released" : "owned" } });
  }, protocol, "desktop", 1, "raw-pair");
  const binding: RelayLocalExecutionBindingV3 = { version: 3, localNetworkPolicy: { mode: "host" }, generation: "host", invocationId: "call", executionId: "execution", operation: "start",
    authority: { kind: "full_mac", activationId: "activation", roomId: "room" }, owner: { instanceId: "", humanUserId: "human", agentId: "agent", runId: "run", conversationId: "thread",
      relayId: "relay", desktopSessionId: "desktop", pairingGeneration: registry.getLocalExecutionPairingGeneration("relay")!, serverBindingId: "server",
      profileId: null, profileRevision: null, grantIds: [], grantRevision: null, protectedPolicyVersion: null } };
  const activation = new AbortController();
  const request = { toolName: "exec_command", args: { cmd: "printf fixture" }, impact: "destructive" as const, approvalObtained: true,
    localExecutionBinding: binding, localExecutionActivationSignal: activation.signal };
  return { registry, sent, binding, activation, request };
}
async function rejected(work: Promise<unknown>) { return work.then(() => false, () => true); }
test("activation revoke after yield cancels retained execution and keeps its readable receipt identity", async () => {
  const f = await fixture(); await f.registry.dispatch("relay", f.request); expect(f.sent).toHaveLength(1);
  f.activation.abort(); expect(f.sent.at(-1)).toMatchObject({ type: "relay:dispatch", toolName: "write_stdin", args: { session_id: "execution", cancel: true } });
  await f.registry.dispatch("relay", { ...f.request, toolName: "write_stdin", args: { session_id: "execution" }, localExecutionBinding: { ...f.binding, operation: "read" } });
  expect(f.sent).toHaveLength(3);
  expect(await rejected(f.registry.dispatch("relay", { ...f.request, localExecutionBinding: { ...f.binding, authority: { ...f.binding.authority, activationId: "replacement" } } }))).toBeTrue();
});
test("confirmed settlement detaches activation; old peers and interactive starts never dispatch", async () => {
  const done = await fixture(29, true); await done.registry.dispatch("relay", done.request); done.activation.abort(); expect(done.sent).toHaveLength(1);
  const old = await fixture(24); expect(await rejected(old.registry.dispatch("relay", old.request))).toBeTrue(); expect(old.sent).toHaveLength(0);
  const f = await fixture(); expect(await rejected(f.registry.dispatch("relay", { ...f.request, args: { ...f.request.args, tty: true } }))).toBeTrue();
  expect(await rejected(f.registry.dispatch("relay", { ...f.request, toolName: "write_stdin", args: { session_id: "execution", chars: "again" }, localExecutionBinding: { ...f.binding, operation: "input" } }))).toBeTrue(); expect(f.sent).toHaveLength(0);
});

test("activation loss during a pending response cancels the same execution before its receipt arrives", async () => {
  const f = await fixture(29, false, true); const pending = f.registry.dispatch("relay", f.request);
  await Promise.resolve(); const start = f.sent.find(message => message.type === "relay:dispatch" && message.toolName === "exec_command");
  if (start?.type !== "relay:dispatch") throw new Error("missing start");
  f.activation.abort(); expect(f.sent.at(-1)).toMatchObject({ type: "relay:dispatch", args: { session_id: "execution", cancel: true } });
  f.registry.resolveDispatch(start.correlationId, { status: "ok", result: { session_id: "execution", state: "cancelled", resources: "released" } });
  await pending;
});
test("offline activation revocation is delivered only to the same retained Desktop generation", async () => {
  const f = await fixture(); await f.registry.dispatch("relay", f.request); await f.registry.unregister("relay"); f.activation.abort();
  const resumed: RelayServerMessage[] = [];
  await f.registry.register("relay", "human", { profile: "desktop-agent", canExecuteLocal: true, canExecuteFullMacOneShot: true,
    localExecution: { version: 1, generation: "host", pipe: true, pty: true, localNetworkPolicy: true, capacity: 2 } }, message => resumed.push(message), 29, "desktop", 2, "raw-pair");
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  expect(resumed.find(message => message.type === "relay:dispatch")).toMatchObject({ type: "relay:dispatch", toolName: "write_stdin", args: { session_id: "execution", cancel: true } });
});
