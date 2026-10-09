import { expect, test } from "bun:test";
import { parseRelayLocalExecutionBinding, projectRelayCapabilitiesForProtocol,
  RELAY_LOCAL_EXECUTION_NETWORK_POLICY_PROTOCOL_VERSION, type RelayLocalExecutionBindingV3 } from "../../src/index";
const binding: RelayLocalExecutionBindingV3 = { version: 3, generation: "host", invocationId: "call", executionId: "execution", operation: "start",
  authority: { kind: "full_mac", activationId: "activation", roomId: "room" }, owner: { instanceId: "", humanUserId: "human", agentId: "agent", runId: "run", conversationId: "thread",
    relayId: "relay", desktopSessionId: "desktop", pairingGeneration: "pair", serverBindingId: "server", profileId: null, profileRevision: null, grantIds: [], grantRevision: null, protectedPolicyVersion: null } };
test("Full Mac wire requires a closed exact activation and cannot describe input or borrowed profile grants", () => {
  expect(parseRelayLocalExecutionBinding(binding)).toEqual(binding);
  for (const operation of ["read", "cancel"] as const) expect(parseRelayLocalExecutionBinding({ ...binding, operation })).not.toBeNull();
  for (const invalid of [{ ...binding, operation: "input" }, { ...binding, authority: { ...binding.authority, activationId: " " } },
    { ...binding, authority: { ...binding.authority, root: "/path/to/project" } }, { ...binding, owner: { ...binding.owner, grantIds: ["grant"] } },
    { ...binding, version: 2 }, { ...binding, version: 1 }]) expect(parseRelayLocalExecutionBinding(invalid)).toBeNull();
});
test("Full Mac support never leaks to peers without the network-policy contract", () => {
  for (let protocol = 9; protocol < RELAY_LOCAL_EXECUTION_NETWORK_POLICY_PROTOCOL_VERSION; protocol++) {
    const caps = projectRelayCapabilitiesForProtocol({ profile: "desktop-agent", canExecuteFullMacOneShot: true, canExecuteLocal: true }, protocol);
    expect(caps.canExecuteFullMacOneShot).toBeUndefined();
    expect(caps.canExecuteLocal).toBeUndefined();
  }
  expect(projectRelayCapabilitiesForProtocol({ profile: "desktop-agent", canExecuteFullMacOneShot: true },
    RELAY_LOCAL_EXECUTION_NETWORK_POLICY_PROTOCOL_VERSION).canExecuteFullMacOneShot).toBeTrue();
});
