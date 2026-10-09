import { expect, test } from "bun:test";
import type { RelayCapabilities } from "../../src/types";
import { parseRelayLocalExecutionBinding, projectRelayCapabilitiesForProtocol,
  RELAY_LOCAL_EXECUTION_NETWORK_POLICY_PROTOCOL_VERSION, type RelayLocalExecutionBindingV4 } from "../../src/index";
const binding: RelayLocalExecutionBindingV4 = {
  version: 4, generation: "generation", invocationId: "call", executionId: "execution", operation: "start",
  owner: { instanceId: "", humanUserId: "human", agentId: "agent", runId: "task-run", conversationId: "task-thread",
    relayId: "relay", desktopSessionId: "desktop", pairingGeneration: "wire-pairing", serverBindingId: "server",
    profileId: null, profileRevision: null, grantIds: ["project-grant"], grantRevision: null, protectedPolicyVersion: 1 },
  authority: { kind: "delegated", taskId: "task", taskRunId: "task-run", roomId: "task-room", delegation: {
    version: 1, humanUserId: "human", agentId: "agent", sourceRoomId: "source-room", sourceConversationId: "source-thread",
    rootTaskId: "task", projectGrantId: "project-grant", ceiling: "basic", profile: null,
    target: { instanceId: "", relayId: "relay", pairingGeneration: "raw-pairing", serverOrigin: "https://server.example", serverFingerprint: "fingerprint" },
  } },
};
test("delegated managed contract binds the exact occurrence and Task grant without a root path", () => {
  for (const operation of ["start", "read", "input", "cancel"] as const) {
    expect(parseRelayLocalExecutionBinding({ ...binding, operation })).not.toBeNull();
  }
  for (const invalid of [
    { ...binding, authority: { ...binding.authority, taskRunId: "other-run" } },
    { ...binding, authority: { ...binding.authority, currentFolder: "/path/to/project" } },
    { ...binding, owner: { ...binding.owner, grantIds: ["other-grant"] } },
    { ...binding, owner: { ...binding.owner, agentId: "other-agent" } },
    { ...binding, authority: { ...binding.authority, delegation: { ...binding.authority.delegation, ceiling: "full_mac" } } },
    { ...binding, version: 1 }, { ...binding, version: 2 }, { ...binding, version: 3 },
  ]) expect(parseRelayLocalExecutionBinding(invalid)).toBeNull();
});
test("Development retains its exact profile and does not promote a Basic grant", () => {
  const profile = { id: "profile", revision: 7 };
  const dev = { ...binding, owner: { ...binding.owner, profileId: profile.id, profileRevision: profile.revision },
    authority: { ...binding.authority, delegation: { ...binding.authority.delegation, ceiling: "development", profile } } };
  expect(parseRelayLocalExecutionBinding(dev)).not.toBeNull();
  expect(parseRelayLocalExecutionBinding({ ...dev, owner: binding.owner })).toBeNull();
  expect(parseRelayLocalExecutionBinding({ ...binding, owner: dev.owner })).toBeNull();
});
test("delegation support is withheld from every older negotiated peer", () => {
  const capabilities: RelayCapabilities = { profile: "desktop-agent", canDelegateLocalExecution: true };
  for (let version = 9; version < RELAY_LOCAL_EXECUTION_NETWORK_POLICY_PROTOCOL_VERSION; version++) {
    expect(projectRelayCapabilitiesForProtocol(capabilities, version).canDelegateLocalExecution).toBeUndefined();
  }
  expect(projectRelayCapabilitiesForProtocol(capabilities,
    RELAY_LOCAL_EXECUTION_NETWORK_POLICY_PROTOCOL_VERSION).canDelegateLocalExecution).toBe(true);
});
