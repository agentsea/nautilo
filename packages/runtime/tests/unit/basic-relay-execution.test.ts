import { expect, test } from "bun:test";
import type { RelayCapabilities, RelayLocalExecutionBindingV2, RelayServerMessage } from "@nautilo/relay";
import { InMemoryRelayRegistry } from "../../src/relay-registry";
async function fixture(protocol = 29) {
  const registry = new InMemoryRelayRegistry(); const sent: RelayServerMessage[] = [];
  const caps: RelayCapabilities = { profile: "desktop-agent", canExecuteLocal: true, localExecution: { version: 1, generation: "generation", pipe: true, pty: true, localNetworkPolicy: true, capacity: 8 }, basicExecution: { version: 1, currentFolder: "/tmp/basic", serverBindingId: "server", protectedPolicyVersion: 1 } };
  await registry.register("relay", "human", caps, message => { sent.push(message); if (message.type === "relay:dispatch") registry.resolveDispatch(message.correlationId, { status: "ok", result: { state: "running", resources: "owned" } }); }, protocol, "desktop", 1, "raw-pair");
  const binding: RelayLocalExecutionBindingV2 = { version: 2, localNetworkPolicy: { mode: "host" }, generation: "generation", executionId: "execution", invocationId: "call", operation: "start", authority: { kind: "basic", roomId: "room-fixture", currentFolder: "/tmp/basic", capabilityRevision: 1, protectedPolicyVersion: 1 }, owner: { instanceId: "", humanUserId: "human", agentId: "agent", runId: "run", conversationId: "conversation", relayId: "relay", desktopSessionId: "desktop", pairingGeneration: registry.getLocalExecutionPairingGeneration("relay")!, serverBindingId: "server", profileId: null, profileRevision: null, grantIds: [], grantRevision: null, protectedPolicyVersion: 1 } };
  const request = { toolName: "exec_command", args: { cmd: "printf fixture" }, impact: "destructive" as const, approvalObtained: true, localExecutionBinding: binding };
  return { registry, sent, caps, binding, request };
}
async function rejected(operation: Promise<unknown>): Promise<string> { return operation.then(() => "unexpected success", error => error instanceof Error ? error.message : "unknown"); }
test("Basic capability survives validated refresh and retained input stays pinned after selection changes", async () => {
  const f = await fixture(); await f.registry.dispatch("relay", f.request);
  const updated = { ...f.caps, basicExecution: { ...f.caps.basicExecution!, currentFolder: "/tmp/other" } };
  expect(f.registry.updateCapabilities({ relayId: "relay", userId: "human", desktopSessionId: "desktop", capabilityRevision: 2, capabilities: updated })).toEqual({ ok: true });
  expect(f.registry.getCapabilities("relay")?.basicExecution).toEqual(updated.basicExecution);
  await f.registry.dispatch("relay", { ...f.request, toolName: "write_stdin", args: { session_id: "execution", chars: "once" }, localExecutionBinding: { ...f.binding, operation: "input" } });
  expect(f.sent).toHaveLength(2);
  expect(await rejected(f.registry.dispatch("relay", f.request))).toContain("BINDING_INVALID");
  expect(await rejected(f.registry.dispatch("relay", { ...f.request, toolName: "write_stdin", args: { session_id: "execution", chars: "once" }, localExecutionBinding: { ...f.binding, operation: "input", authority: { ...f.binding.authority, currentFolder: "/tmp/other" } } }))).toContain("OWNER_FENCED");
});
test("Basic rejects old protocol, forged root and mixed profile without sending", async () => {
  const old = await fixture(22); expect(await rejected(old.registry.dispatch("relay", old.request))).toContain("BINDING_INVALID"); expect(old.sent).toHaveLength(0);
  const f = await fixture();
  for (const binding of [{ ...f.binding, authority: { ...f.binding.authority, currentFolder: "/tmp/foreign" } }, { ...f.binding, owner: { ...f.binding.owner, profileId: "profile", profileRevision: 1 } }]) {
    expect(await rejected(f.registry.dispatch("relay", { ...f.request, localExecutionBinding: binding }))).toContain("BINDING_INVALID");
  }
  expect(f.sent).toHaveLength(0);
});
