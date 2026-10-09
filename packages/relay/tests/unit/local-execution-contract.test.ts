import { describe, expect, test } from "bun:test";
import { parseRelayLocalExecutionCapability, parseRelayLocalExecutionBinding, parseRelayLocalExecutionUncertainty, projectRelayCapabilitiesForProtocol,
  LOCAL_EXECUTION_MAX_IDENTITIES, type RelayLocalExecutionBindingV1 } from "../../src/index";

const binding: RelayLocalExecutionBindingV1 = { version: 1, generation: "generation-fixture", invocationId: "call-fixture",
  executionId: "execution-fixture", operation: "start", owner: { instanceId: "instance-fixture", humanUserId: "human-fixture",
    agentId: "agent-fixture", runId: "run-fixture", conversationId: "conversation-fixture", relayId: "relay-fixture", desktopSessionId: "desktop-fixture",
    pairingGeneration: "pairing-fixture", serverBindingId: "server-fixture", profileId: null, profileRevision: null,
    grantIds: [], grantRevision: null, protectedPolicyVersion: null } };
describe("contained execution contract", () => {
  test("strictly parses complete generation and owner metadata", () => {
    expect(parseRelayLocalExecutionBinding(binding)).toEqual(binding);
    expect(parseRelayLocalExecutionBinding({ ...binding, roots: ["/path/to/project"] })).toBeNull();
    expect(parseRelayLocalExecutionBinding({ ...binding, owner: { ...binding.owner, token: "synthetic" } })).toBeNull();
    expect(parseRelayLocalExecutionBinding({ ...binding, owner: { ...binding.owner, profileId: "profile-fixture" } })).toBeNull();
    expect(parseRelayLocalExecutionBinding({ ...binding, generation: "" })).toBeNull();
  });
  test("uncertain delivery carries only a strict matching recovery locator, never authority or a receipt", () => {
    const value = { version: 1, kind: "local_execution_outcome_unknown", generation: "generation-fixture",
      executionId: "execution-fixture", session_id: "execution-fixture", operation: "start", outcome: "unknown",
      recovery: "read_or_cancel_same_execution", message: "Read or stop the same execution." } as const;
    expect(parseRelayLocalExecutionUncertainty(value)).toEqual(value);
    for (const changed of [{ session_id: "foreign" }, { generation: "" }, { outcome: "not_started" },
      { recovery: "relaunch" }, { operation: "spawn" }, { operation: ["start"] }, { owner: binding.owner }, { state: "running" }, { version: 2 }]) {
      expect(parseRelayLocalExecutionUncertainty({ ...value, ...changed })).toBeNull();
    }
  });
  test("requires an explicit capacity and projects execution away for older peers", () => {
    const capability = { version: 1 as const, generation: "generation-fixture", pipe: true as const,
      pty: true, capacity: LOCAL_EXECUTION_MAX_IDENTITIES };
    expect(parseRelayLocalExecutionCapability(capability)).toEqual(capability);
    expect(parseRelayLocalExecutionCapability({ ...capability, capacity: 0 })).toBeNull();
    expect(parseRelayLocalExecutionCapability({ ...capability, command: "echo fixture" })).toBeNull();
    const old = projectRelayCapabilitiesForProtocol({ profile: "desktop-agent", canExecuteLocal: true, localExecution: capability }, 19);
    expect(old.localExecution).toBeUndefined();
    expect(old.canExecuteLocal).toBeUndefined();
  });
});
