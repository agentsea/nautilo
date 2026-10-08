import { expect, test } from "bun:test";
import { InMemoryWorkstationDispatchPlanRegistry, revalidatePlanAgainstRelay, type BasicWorkstationDispatchPlan, type WorkstationRelayFingerprint } from "../../src/workstation-dispatch-plan";
const plan: BasicWorkstationDispatchPlan = { executionClass: "basic_sandbox", toolCallId: "call", userId: "human", agentId: "agent", roomId: "room", conversationId: "thread", relayId: "relay", instanceId: "", desktopSessionId: "desktop", serverBindingId: "server", pairingGeneration: "raw-pair", profileId: null, profileRevision: null, grantIds: [], grantRevision: null, capabilityRevision: 4, admittedAt: new Date().toISOString(), currentFolder: "/tmp/basic", protectedPolicyVersion: 1 };
const fingerprint: WorkstationRelayFingerprint = { userId: "human", desktopSessionId: "desktop", pairingGeneration: "raw-pair", capabilityRevision: 4, profileId: null, profileRevision: null, basicExecution: { currentFolder: "/tmp/basic", serverBindingId: "server", protectedPolicyVersion: 1 } };
test("Basic uses canonical registry with no profile and fences each selected authority change", () => {
  const registry = new InMemoryWorkstationDispatchPlanRegistry();
  registry.admit(plan); expect(registry.get("call")).toEqual(plan);
  expect(revalidatePlanAgainstRelay(plan, fingerprint)).toEqual({ ok: true });
  for (const change of [{ userId: "other" }, { desktopSessionId: "other" }, { pairingGeneration: "other" }, { capabilityRevision: 5 }, { basicExecution: null }, { basicExecution: { ...fingerprint.basicExecution!, currentFolder: "/tmp/other" } }, { basicExecution: { ...fingerprint.basicExecution!, protectedPolicyVersion: 2 } }]) {
    expect(revalidatePlanAgainstRelay(plan, { ...fingerprint, ...change }).ok).toBe(false);
  }
  registry.invalidateForBinding({ userId: "human", relayId: "relay", desktopSessionId: "desktop" }); expect(registry.get("call")).toBeNull();
});
