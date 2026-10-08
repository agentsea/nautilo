import { describe, expect, test } from "bun:test";
import { parseRelayLocalExecutionBinding, projectRelayCapabilitiesForProtocol, RELAY_LOCAL_EXECUTION_NETWORK_POLICY_PROTOCOL_VERSION,
  RELAY_MIN_SUPPORTED_PROTOCOL_VERSION, type RelayLocalExecutionBindingV2 } from "../../src/protocol";
import { parseRelayBasicExecutionCapability, type RelayCapabilities } from "../../src/types";
const basic = { version: 1 as const, currentFolder: "/tmp/basic-project", serverBindingId: "server", protectedPolicyVersion: 1 };
const binding: RelayLocalExecutionBindingV2 = { version: 2, generation: "generation", invocationId: "call", executionId: "execution", operation: "start",
  authority: { kind: "basic", roomId: "room-fixture", currentFolder: basic.currentFolder, capabilityRevision: 4, protectedPolicyVersion: 1 },
  owner: { instanceId: "", humanUserId: "human", agentId: "agent", runId: "run", conversationId: "room:fixture", relayId: "relay", desktopSessionId: "desktop", pairingGeneration: "opaque-pair", serverBindingId: "server", profileId: null, profileRevision: null, grantIds: [], grantRevision: null, protectedPolicyVersion: 1 } };
describe("Basic execution wire boundary", () => {
  test("requires the explicit variant and rejects mixed profile or caller authority", () => {
    expect(parseRelayLocalExecutionBinding(binding)).toEqual(binding);
    for (const change of [{ profileId: "profile", profileRevision: 1 }, { grantIds: ["grant"] }, { grantRevision: 1 }, { protectedPolicyVersion: 2 }]) {
      expect(parseRelayLocalExecutionBinding({ ...binding, owner: { ...binding.owner, ...change } })).toBeNull();
    }
    expect(parseRelayLocalExecutionBinding({ ...binding, authority: { ...binding.authority, home: "/tmp/caller" } })).toBeNull();
    expect(parseRelayLocalExecutionBinding({ ...binding, version: 1 })).toBeNull();
    const { authority: _authority, ...v1 } = binding;
    expect(parseRelayLocalExecutionBinding({ ...v1, version: 1 })).not.toBeNull();
    expect(parseRelayBasicExecutionCapability({ ...basic, network: "host" })).toBeNull();
  });
  test("old peers cannot execute Basic while retaining versioned metadata and history", () => {
    const caps: RelayCapabilities = { profile: "desktop-agent", canExecuteLocal: true, canReadLocalExecutionHistory: true, basicExecution: basic,
      localExecution: { version: 1, generation: "generation", pipe: true, pty: true, capacity: 4 } };
    for (let version = RELAY_MIN_SUPPORTED_PROTOCOL_VERSION; version < RELAY_LOCAL_EXECUTION_NETWORK_POLICY_PROTOCOL_VERSION; version++) {
      const projected = projectRelayCapabilitiesForProtocol(caps, version);
      expect(projected.basicExecution).toEqual(version >= 23 ? basic : undefined);
      expect(projected.canExecuteLocal).toBeUndefined();
      expect(projected.canReadLocalExecutionHistory).toBe(version >= 21 ? true : undefined);
      const development = projectRelayCapabilitiesForProtocol({ ...caps, workstationProfileSnapshot: { profileId: "profile" } as RelayCapabilities["workstationProfileSnapshot"] }, version);
      expect(development.canExecuteLocal).toBeUndefined();
    }
    expect(projectRelayCapabilitiesForProtocol(caps, RELAY_LOCAL_EXECUTION_NETWORK_POLICY_PROTOCOL_VERSION)).toEqual(caps);
  });
});
