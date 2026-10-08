import { expect, test } from "bun:test";
import { InMemoryRelayRegistry, InMemoryWorkstationSessionRegistry, InMemoryWorkstationDispatchPlanRegistry } from "@nautilo/runtime";
import { createWorkstationApprovalOverrideResolver, type WorkstationOverrideResolverRequest } from "../../src/routes/workstation-access";
import type { RelayCapabilities } from "@nautilo/relay";
async function fixture(protocol = 23) {
  const relayRegistry = new InMemoryRelayRegistry(); const registry = new InMemoryWorkstationSessionRegistry();
  const planRegistry = new InMemoryWorkstationDispatchPlanRegistry();
  const caps: RelayCapabilities = { profile: "desktop-agent", canExecuteLocal: true,
    localExecution: { version: 1, generation: "gen", pipe: true, pty: true, capacity: 8 },
    basicExecution: { version: 1, currentFolder: "/tmp/basic", serverBindingId: "server", protectedPolicyVersion: 1 },
    desktopFilesystemGrantSnapshot: { revision: 0, instanceId: "", agentScope: "all_owned_agents", grants: [] } };
  await relayRegistry.register("relay", "human", caps, () => {}, protocol, "desktop", 3, "raw-pair");
  const resolver = createWorkstationApprovalOverrideResolver({ registry, relayRegistry, planRegistry });
  const request: WorkstationOverrideResolverRequest = { userId: "human", agentId: "agent", actorId: "actor", roomId: "room", conversationId: "thread", currentFolder: "", workspacePath: "", requiredRelayId: "relay",
    verifiedOrdinaryOrigin: { kind: "local_electron", userId: "human", actorId: "actor", relayId: "relay", desktopSessionId: "desktop", pairingGeneration: "raw-pair", requestId: "request" },
    toolCall: { id: "call", name: "exec_command", args: { cmd: "printf fixture" } } };
  return { resolver, request, planRegistry, relayRegistry, registry };
}
test("Basic no-PIN admission requires exact foreground origin and produces a real null-profile plan", async () => {
  const f = await fixture();
  expect(f.resolver(f.request)).toEqual({ override: "auto", executionClass: "basic_sandbox" });
  expect(f.planRegistry.get("call")).toMatchObject({ executionClass: "basic_sandbox", profileId: null, profileRevision: null, grantIds: [], grantRevision: null, agentId: "agent", roomId: "room", currentFolder: "/tmp/basic" });
  for (const change of [{ verifiedOrdinaryOrigin: null }, { userId: "foreign" }, { requiredRelayId: "foreign" }, { roomId: "" }, { currentFolder: "/tmp/request-root" }, { verifiedOrdinaryOrigin: { ...f.request.verifiedOrdinaryOrigin!, pairingGeneration: "old-pair" } }]) {
    f.planRegistry.clear(); expect(f.resolver({ ...f.request, ...change }).override).toBe("none"); expect(f.planRegistry.get("call")).toBeNull();
  }
});
test("old peer and critical/elevation commands cannot obtain Basic automatic admission", async () => {
  const old = await fixture(22); expect(old.resolver(old.request).override).toBe("none");
  const f = await fixture();
  for (const cmd of ["sudo id", "rm -rf /"]) expect(f.resolver({ ...f.request, toolCall: { ...f.request.toolCall, args: { cmd } } }).override).toBe("none");
});

test("another Desktop's Development session neither grants nor blocks exact selected Basic", async () => {
  const f = await fixture();
  const other = { userId: "human", instanceId: "", relayId: "other-relay", desktopSessionId: "other-desktop", serverBindingId: "other-server", pairingGeneration: "other-pair", agentScope: "all_owned_agents" as const, profileId: "profile", profileRevision: 1, grantIds: [], capabilityRevision: 1 };
  expect(f.registry.activate(other, other).ok).toBe(true);
  expect(f.resolver(f.request)).toEqual({ override: "auto", executionClass: "basic_sandbox" });
  expect(f.planRegistry.get("call")?.relayId).toBe("relay");
});
