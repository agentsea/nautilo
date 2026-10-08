import { describe, expect, test } from "bun:test";
import type { RelayLocalExecutionBindingV1, RelayServerMessage } from "@nautilo/relay";
import { InMemoryRelayRegistry } from "../../src/relay-registry";
const binding: RelayLocalExecutionBindingV1 = { version: 1, generation: "generation-fixture", invocationId: "call-fixture",
  executionId: "execution-fixture", operation: "start", owner: { instanceId: "instance-fixture", humanUserId: "human-fixture",
    agentId: "agent-fixture", runId: "run-fixture", conversationId: "conversation-fixture", relayId: "relay-fixture", desktopSessionId: "desktop-fixture",
    pairingGeneration: "pairing-fixture", serverBindingId: "server-fixture", profileId: null, profileRevision: null,
    grantIds: [], grantRevision: null, protectedPolicyVersion: null } };
async function fixture(capacity = 1, protocol = 20, receipt = { state: "running", resources: "owned" }) {
  const registry = new InMemoryRelayRegistry();
  const sent: RelayServerMessage[] = [];
  await registry.register("relay-fixture", "human-fixture", { profile: "desktop-agent", canExecuteLocal: true,
    localExecution: { version: 1, generation: "generation-fixture", pipe: true, pty: true, capacity } }, message => {
      sent.push(message);
      if (message.type === "relay:dispatch") registry.resolveDispatch(message.correlationId,
        { status: "ok", result: { session_id: message.localExecutionBinding?.executionId, ...receipt } });
    }, protocol, "desktop-fixture", 1, "pairing-fixture");
  const admittedBinding = { ...binding, owner: { ...binding.owner, pairingGeneration: registry.getLocalExecutionPairingGeneration("relay-fixture")! } };
  return { registry, sent, admittedBinding };
}
describe("managed execution Relay ownership", () => {
  test("releases the owning-run listener only on confirmed terminal resource release while retaining replay identity", async () => {
    const { registry, sent, admittedBinding } = await fixture(1, 20, { state: "completed", resources: "released" });
    const controller = new AbortController();
    const request = { toolName: "exec_command", args: { cmd: "echo fixture" }, impact: "destructive" as const,
      approvalObtained: true, localExecutionBinding: admittedBinding, signal: controller.signal };
    await registry.dispatch("relay-fixture", request);
    controller.abort();
    expect(sent).toHaveLength(1);
    expect(registry.getLocalExecutionBinding("relay-fixture", admittedBinding.executionId)).toEqual(admittedBinding);
    expect(registry.dispatch("relay-fixture", { ...request, signal: new AbortController().signal, args: { cmd: "different" } })).rejects.toThrow("REQUEST_CONFLICT");
  });
  test("capability refresh preserves the exact managed contract and rejects a peer-raised identity ceiling", async () => {
    const { registry } = await fixture();
    const capabilities = { profile: "desktop-agent" as const, canExecuteLocal: true,
      localExecution: { version: 1 as const, generation: "generation-fixture", pipe: true as const, pty: true, capacity: 1 } };
    expect(registry.updateCapabilities({ relayId: "relay-fixture", userId: "human-fixture", desktopSessionId: "desktop-fixture",
      capabilityRevision: 2, capabilities })).toEqual({ ok: true });
    expect(registry.getCapabilities("relay-fixture")?.localExecution).toEqual(capabilities.localExecution);
    expect(registry.updateCapabilities({ relayId: "relay-fixture", userId: "human-fixture", desktopSessionId: "desktop-fixture",
      capabilityRevision: 3, capabilities: { ...capabilities, localExecution: { ...capabilities.localExecution, capacity: 1025 } } }).ok).toBe(false);
  });
  test("retains the owner after yield and delivers Stop without a start reply reference", async () => {
    const { registry, sent, admittedBinding } = await fixture();
    const controller = new AbortController();
    await registry.dispatch("relay-fixture", { toolName: "exec_command", args: { cmd: "echo fixture" },
      impact: "destructive", approvalObtained: true, localExecutionBinding: admittedBinding, signal: controller.signal });
    expect(registry.getLocalExecutionBinding("relay-fixture", "execution-fixture")).toEqual(admittedBinding);
    controller.abort();
    const stop = sent.at(-1);
    expect(stop).toMatchObject({ type: "relay:dispatch", toolName: "write_stdin", args: { session_id: "execution-fixture", cancel: true },
      localExecutionBinding: { operation: "cancel", executionId: "execution-fixture", owner: admittedBinding.owner } });
    expect(registry.dispatch("relay-fixture", { toolName: "write_stdin", args: { session_id: "execution-fixture", chars: "again" },
      impact: "destructive", approvalObtained: true, localExecutionBinding: { ...admittedBinding, operation: "input" } })).rejects.toThrow("OWNER_FENCED");
  });
  test("denies foreign ownership, old peers, conflicting replay, and exhausted retained identities", async () => {
    const { registry, admittedBinding } = await fixture();
    const request = { toolName: "exec_command", args: { cmd: "echo fixture" }, impact: "destructive" as const,
      approvalObtained: true, localExecutionBinding: admittedBinding };
    expect(registry.dispatch("relay-fixture", { ...request, localExecutionBinding: { ...admittedBinding,
      owner: { ...admittedBinding.owner, humanUserId: "other-human" } } })).rejects.toThrow("BINDING_INVALID");
    await registry.dispatch("relay-fixture", request);
    expect(registry.dispatch("relay-fixture", { ...request, args: { cmd: "different" } })).rejects.toThrow("REQUEST_CONFLICT");
    expect(registry.dispatch("relay-fixture", { ...request, localExecutionBinding: { ...admittedBinding,
      owner: { ...admittedBinding.owner, grantRevision: 2, profileId: "new-profile", profileRevision: 2 } } })).rejects.toThrow("REQUEST_CONFLICT");
    expect(registry.dispatch("relay-fixture", { ...request, localExecutionBinding: { ...admittedBinding,
      executionId: "other-execution", invocationId: "other-call" } })).rejects.toThrow("CAPACITY_REACHED");
    const old = await fixture(1, 19);
    expect(old.registry.dispatch("relay-fixture", request)).rejects.toThrow("BINDING_INVALID");
  });
  test("queues owning-run Stop offline and delivers it only to the same generation", async () => {
    const { registry, admittedBinding } = await fixture();
    const controller = new AbortController();
    await registry.dispatch("relay-fixture", { toolName: "exec_command", args: { cmd: "echo fixture" },
      impact: "destructive", approvalObtained: true, localExecutionBinding: admittedBinding, signal: controller.signal });
    await registry.unregister("relay-fixture");
    controller.abort();
    const reconnected: RelayServerMessage[] = [];
    const capabilities = { profile: "desktop-agent" as const, canExecuteLocal: true,
      localExecution: { version: 1 as const, generation: "generation-fixture", pipe: true as const, pty: true, capacity: 1 } };
    await registry.register("relay-fixture", "human-fixture", capabilities, (message: RelayServerMessage) => reconnected.push(message),
      20, "desktop-fixture", 2, "pairing-fixture");
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    const stop = reconnected.find(message => message.type === "relay:dispatch" && message.toolName === "write_stdin");
    expect(stop?.type === "relay:dispatch" ? stop.localExecutionBinding?.operation : null).toBe("cancel");
    expect(stop?.type === "relay:dispatch" ? stop.localExecutionBinding?.executionId : null).toBe("execution-fixture");
    await registry.register("relay-fixture", "human-fixture", { ...capabilities,
      localExecution: { ...capabilities.localExecution, generation: "replacement-generation" } }, () => {},
      20, "replacement-desktop", 3, "pairing-fixture");
    expect(registry.getLocalExecutionBinding("relay-fixture", "execution-fixture")).toBeNull();
  });

});
