import { describe, expect, test } from "bun:test";
import {
  MAX_ACTIVE_DOMAINS_PER_DEVICE,
  assertDeviceFanoutPlan,
  createDeviceFanoutProgress,
  deriveDeviceFanoutOperationState,
  evaluateDeviceActivationGate,
  type DeviceActivationGate,
  type DeviceFanoutDomainProgress,
  type DeviceFanoutPlan,
} from "../../src/index.ts";

function plan(
  overrides: Partial<DeviceFanoutPlan> = {},
): DeviceFanoutPlan {
  return {
    formatVersion: 1,
    operationId: "operation_device_fanout",
    method: "device_approval",
    humanId: "human_alice",
    targetDeviceId: "device_alice_new",
    expectedDeviceRevision: 0,
    expectedCustodyRevision: 4,
    expectedRecoveryGeneration: 2,
    inventoryRevision: 8,
    inventoryCount: 2,
    inventoryDigest: new Uint8Array(32).fill(0x31),
    authorizationArtifactHash: new Uint8Array(32).fill(0x41),
    recoveryReadinessDigest: null,
    fanoutRowCount: 4,
    aggregatePayloadBytes: 1_024,
    domains: [{
      domainId: "domain_ab",
      expectedEpoch: 3,
      targetEpoch: 4,
      expectedAuthorizationRevision: 7,
      expectedParticipantDigest: new Uint8Array(32).fill(0x51),
      committerDeviceId: "device_alice_current",
      namespaces: [{
        namespaceId: "namespace_room",
        expectedAccessRevision: 9,
        expectedBindingHash: new Uint8Array(32).fill(0x61),
      }],
    }],
    ...overrides,
  };
}

function activeProgress(): readonly DeviceFanoutDomainProgress[] {
  return [{
    domainId: "domain_ab",
    state: "active",
    namespaces: [{
      namespaceId: "namespace_room",
      state: "active",
    }],
  }];
}

function gateInput(overrides: Record<string, unknown> = {}) {
  const value = plan();
  return {
    plan: value,
    device: { state: "pending" as const, revision: 0 },
    custodyRevision: 4,
    recoveryGeneration: 2,
    inventoryRevision: 8,
    inventoryCount: 2,
    inventoryDigest: value.inventoryDigest,
    authorizationArtifactHash: value.authorizationArtifactHash,
    domainProgress: activeProgress(),
    requiredDeliveryCount: 4,
    acknowledgedDeliveryCount: 4,
    challengeStatus: "pending" as const,
    activeDeviceCount: 1,
    ...overrides,
  };
}

describe("device fanout model", () => {
  test("creates bounded pending progress from a canonical plan", () => {
    const value = plan();
    assertDeviceFanoutPlan(value);
    expect(createDeviceFanoutProgress(value)).toEqual({
      operationId: value.operationId,
      state: "awaiting_committer",
      domains: [{
        domainId: "domain_ab",
        state: "awaiting_committer",
        namespaces: [{
          namespaceId: "namespace_room",
          state: "pending",
        }],
      }],
    });
  });

  test("rejects skipped epochs, unordered coordinates, and missing committers", () => {
    expect(() => assertDeviceFanoutPlan(plan({
      domains: [{
        ...plan().domains[0]!,
        targetEpoch: 5,
      }],
    }))).toThrow("advance exactly once");
    expect(() => assertDeviceFanoutPlan(plan({
      domains: [
        { ...plan().domains[0]!, domainId: "domain_b" },
        { ...plan().domains[0]!, domainId: "domain_a" },
      ],
    }))).toThrow("canonically ordered");
    expect(() => assertDeviceFanoutPlan(plan({
      domains: [{
        ...plan().domains[0]!,
        committerDeviceId: null,
      }],
    }))).toThrow("requires a live Domain committer");
  });

  test("allows explicit recovery rebootstrap but enforces the Domain ceiling", () => {
    expect(() => assertDeviceFanoutPlan(plan({
      method: "recovery",
      recoveryReadinessDigest: new Uint8Array(32).fill(0x71),
      domains: [{
        ...plan().domains[0]!,
        committerDeviceId: null,
      }],
    }))).not.toThrow();
    expect(() => assertDeviceFanoutPlan(plan({
      domains: Array.from(
        { length: MAX_ACTIVE_DOMAINS_PER_DEVICE + 1 },
        (_, index) => ({
          ...plan().domains[0]!,
          domainId: `domain_${String(index).padStart(3, "0")}`,
        }),
      ),
    }))).toThrow("finite bound");
  });

  test("derives top-level progress without treating blocked as a state", () => {
    const base = activeProgress()[0]!;
    expect(deriveDeviceFanoutOperationState([base])).toBe(
      "ready_to_activate",
    );
    expect(deriveDeviceFanoutOperationState([{
      ...base,
      state: "preparing",
    }])).toBe("preparing_domain");
    expect(deriveDeviceFanoutOperationState([{
      ...base,
      state: "awaiting_delivery",
    }])).toBe("awaiting_delivery");
    expect(deriveDeviceFanoutOperationState([{
      ...base,
      state: "failed",
    }])).toBe("failed");
  });

  test("activates only when every durable coordinate still matches", () => {
    expect(evaluateDeviceActivationGate(gateInput())).toEqual({
      ready: true,
    });
    const cases: readonly [
      Extract<DeviceActivationGate, { ready: false }>["reason"],
      Record<string, unknown>,
    ][] = [
      ["device_changed", {
        device: { state: "revoked", revision: 0 },
      }],
      ["custody_changed", { custodyRevision: 5 }],
      ["recovery_changed", { recoveryGeneration: 3 }],
      ["inventory_changed", { inventoryRevision: 9 }],
      ["authorization_changed", {
        authorizationArtifactHash: new Uint8Array(32).fill(0x99),
      }],
      ["domains_incomplete", {
        domainProgress: [{
          ...activeProgress()[0]!,
          state: "awaiting_delivery",
        }],
      }],
      ["namespaces_incomplete", {
        domainProgress: [{
          ...activeProgress()[0]!,
          namespaces: [{
            namespaceId: "namespace_room",
            state: "prepared",
          }],
        }],
      }],
      ["delivery_incomplete", { acknowledgedDeliveryCount: 3 }],
      ["challenge_consumed", { challengeStatus: "consumed" }],
      ["active_device_limit", { activeDeviceCount: 16 }],
    ];
    for (const [reason, overrides] of cases) {
      expect(evaluateDeviceActivationGate(gateInput(overrides))).toEqual({
        ready: false,
        reason,
      });
    }
  });
});
