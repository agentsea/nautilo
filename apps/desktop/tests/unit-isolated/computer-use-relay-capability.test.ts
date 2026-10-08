import { beforeAll, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { projectRelayCapabilitiesForProtocol } from "@nautilo/relay";
import type { ComputerUseHostContract } from "@nautilo/computer-use-host-protocol";

mock.module("electron", () => ({ app: { getPath: () => "/tmp/nautilo-computer-use-capability-test" } }));

let projectComputerUseRelayCapabilities: typeof import("../../electron/relay.ts").projectComputerUseRelayCapabilities;
let projectComputerUseDispatchRuntime: typeof import("../../electron/relay.ts").projectComputerUseDispatchRuntime;
let requiresComputerUseTopologyReconciliation: typeof import("../../electron/relay.ts").requiresComputerUseTopologyReconciliation;
let buildForStableComputerUseRuntime: typeof import("../../electron/computer-use/semantic-contracts.ts").buildForStableComputerUseRuntime;

beforeAll(async () => {
  ({
    projectComputerUseRelayCapabilities,
    projectComputerUseDispatchRuntime,
    requiresComputerUseTopologyReconciliation,
  } = await import("../../electron/relay.ts"));
  ({ buildForStableComputerUseRuntime } = await import("../../electron/computer-use/semantic-contracts.ts"));
});

const snapshot = {
  enabled: true as const,
  agentId: "agent-1",
  installationEpoch: "epoch-1",
  grantGeneration: 1,
  provider: "cua" as const,
  providerGeneration: "provider-generation-1",
};

describe("Cua-only relay capability projection", () => {
  test("main reads supported contracts from the active broker", () => {
    const source = readFileSync(new URL("../../electron/main.ts", import.meta.url), "utf8");
    expect(source).toContain("hostContracts: await computerUseHostBroker.supportedContracts()");
  });

  test("preserves exact descriptors for compatible peers and omits them for legacy peers", () => {
    const contract: ComputerUseHostContract = {
      contractNamespace: "test.native", contractId: "observe", contractVersion: 1,
      schemaDigest: `sha256:${"a".repeat(64)}`, effectClass: "read", replayClass: "safe",
      authorityClass: "standing_computer_use", attachmentClass: "none", disclosureClass: "semantic",
    };
    const capabilities = { profile: "desktop-agent" as const,
      ...projectComputerUseRelayCapabilities({ ...snapshot, hostContracts: [contract] }) };
    expect(capabilities.desktopAutomation).toEqual(snapshot);
    expect(projectRelayCapabilitiesForProtocol(capabilities, 17).computerUseHostContracts).toEqual([contract]);
    expect(projectRelayCapabilitiesForProtocol(capabilities, 16).computerUseHostContracts).toBeUndefined();
    expect(capabilities.computerUseHostContracts).toEqual([contract]);
  });

  test("keeps Host descriptors separate from the unchanged legacy grant tuple", () => {
    expect(projectComputerUseRelayCapabilities({ ...snapshot, hostContracts: [] })).toEqual({
      canControlDesktop: true, desktopAutomation: snapshot, computerUseHostContracts: [],
    });
  });
  test("does not advertise desktop control while Computer Use is Off or Cua is unavailable", () => {
    expect(projectComputerUseRelayCapabilities(undefined)).toEqual({ canControlDesktop: false });
  });

  test("advertises desktop control only with the exact fresh Cua snapshot", () => {
    expect(projectComputerUseRelayCapabilities(snapshot)).toEqual({
      canControlDesktop: true,
      desktopAutomation: snapshot,
    });
  });

  test("has no projection that advertises control without semantic authority", () => {
    for (const input of [undefined, snapshot] as const) {
      const projected = projectComputerUseRelayCapabilities(input);
      expect(projected.canControlDesktop).toBe(projected.desktopAutomation !== undefined);
    }
  });

  test("does not advertise a snapshot when Relay topology changes during its local read", async () => {
    const firstRuntime = {
      instanceId: "default",
      humanUserId: "human-1",
      serverBindingId: "server-1",
      relayId: "relay-1",
      pairingGeneration: "pairing-1",
      desktopSessionId: "session-1",
    };
    let currentRuntime = firstRuntime;
    let finishBuild: ((value: typeof snapshot) => void) | undefined;
    const pendingBuild = new Promise<typeof snapshot>((resolve) => { finishBuild = resolve; });
    const pending = buildForStableComputerUseRuntime({
      initialRuntime: firstRuntime,
      currentRuntime: () => currentRuntime,
      build: () => pendingBuild,
    });

    currentRuntime = { ...firstRuntime, pairingGeneration: "pairing-2" };
    finishBuild?.(snapshot);

    expect(await pending).toEqual({ stable: false });
  });

  test("keeps setup authority unavailable on a pre-v17 relay topology", () => {
    const topology = {
      relayId: "relay-1",
      relaySessionId: "relay-session-1",
      pairingGeneration: "pairing-1",
      desktopSessionId: "session-1",
      selectedProtocolVersion: 16,
      capabilityRevision: 0,
    };
    const input = { topology, serverBindingId: "server-1", instanceId: "default", humanUserId: "human-1" };
    expect(projectComputerUseDispatchRuntime(input)).toBeNull();
    expect(projectComputerUseDispatchRuntime({ ...input, topology: { ...topology, selectedProtocolVersion: 17 } }))
      .toMatchObject({ relayId: "relay-1", serverBindingId: "server-1" });
  });

  test("does not turn a capability-revision acknowledgement into a Computer Use refresh loop", () => {
    const topology = {
      relayId: "relay-1",
      relaySessionId: "relay-session-1",
      pairingGeneration: "pairing-1",
      desktopSessionId: "session-1",
      selectedProtocolVersion: 19,
      capabilityRevision: 0,
    };
    const input = {
      topology,
      serverBindingId: "server-1",
      instanceId: "default",
      humanUserId: "human-1",
    };
    const initial = projectComputerUseDispatchRuntime(input);
    const acknowledged = projectComputerUseDispatchRuntime({
      ...input,
      topology: { ...topology, capabilityRevision: 1 },
    });

    expect(requiresComputerUseTopologyReconciliation(null, initial)).toBe(true);
    expect(requiresComputerUseTopologyReconciliation(initial, acknowledged)).toBe(false);
    expect(requiresComputerUseTopologyReconciliation(initial, {
      ...acknowledged!,
      pairingGeneration: "pairing-2",
    })).toBe(true);
    expect(requiresComputerUseTopologyReconciliation(initial, null)).toBe(false);
  });
});
