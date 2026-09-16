import { describe, expect, test } from "bun:test";
import type { RelayCapabilities } from "@nautilo/relay";
import {
  FULL_WORKSTATION_AGENT_SCOPE,
  InMemoryRelayRegistry,
  InMemoryWorkstationDispatchPlanRegistry,
  InMemoryWorkstationSessionRegistry,
  type FullWorkstationBinding,
  type WorkstationDispatchPlan,
} from "@nautilo/runtime";
import {
  createRelayPairingGenerationInvalidator,
  type RelaySocketLifecycleController,
} from "../../src/realtime/relay-endpoint";

const CAPS: RelayCapabilities = { profile: "desktop-agent" } as RelayCapabilities;

function binding(overrides: Partial<FullWorkstationBinding> = {}): FullWorkstationBinding {
  return {
    userId: "user-a",
    instanceId: "instance-a",
    relayId: "relay-a",
    desktopSessionId: "desktop-session-a",
    serverBindingId: "server-binding-a",
    pairingGeneration: "revoked-token-row",
    agentScope: FULL_WORKSTATION_AGENT_SCOPE,
    profileId: "profile-a",
    profileRevision: 1,
    grantIds: ["grant-a"],
    capabilityRevision: 1,
    ...overrides,
  };
}

function plan(overrides: Partial<WorkstationDispatchPlan> = {}): WorkstationDispatchPlan {
  const b = binding();
  return {
    toolCallId: "tool-call-a",
    userId: b.userId,
    relayId: b.relayId,
    instanceId: b.instanceId,
    desktopSessionId: b.desktopSessionId,
    serverBindingId: b.serverBindingId,
    pairingGeneration: b.pairingGeneration,
    profileId: b.profileId,
    profileRevision: b.profileRevision,
    grantIds: b.grantIds,
    capabilityRevision: b.capabilityRevision,
    executionClass: "profile_bound_sandbox",
    admittedAt: "2026-07-29T00:00:00.000Z",
    ...overrides,
  };
}

describe("relay pairing-generation lifecycle reconciliation (D480)", () => {
  test("invalidates only exact caller-owned live authority then disconnects it", async () => {
    const relayRegistry = new InMemoryRelayRegistry();
    const sessions = new InMemoryWorkstationSessionRegistry();
    const plans = new InMemoryWorkstationDispatchPlanRegistry({
      ttlMs: Number.MAX_SAFE_INTEGER,
    });
    const targetBinding = binding();
    expect(sessions.activate(targetBinding, targetBinding).ok).toBe(true);
    plans.admit(plan());
    plans.admit(
      plan({
        toolCallId: "foreign-tool-call",
        userId: "user-b",
        relayId: "relay-b",
        desktopSessionId: "desktop-session-b",
        pairingGeneration: "revoked-token-row",
      }),
    );

    await relayRegistry.register(
      "relay-a",
      "user-a",
      CAPS,
      () => {},
      7,
      "desktop-session-a",
      1,
      "revoked-token-row",
    );
    // Same generation text is intentionally not enough: this foreign user's
    // relay and plan must remain intact.
    await relayRegistry.register(
      "relay-b",
      "user-b",
      CAPS,
      () => {},
      7,
      "desktop-session-b",
      1,
      "revoked-token-row",
    );
    await relayRegistry.register(
      "relay-a-new-generation",
      "user-a",
      CAPS,
      () => {},
      7,
      "desktop-session-new",
      1,
      "still-active-token-row",
    );

    const closed: string[] = [];
    const sockets: RelaySocketLifecycleController = {
      closeRelays(relayIds) {
        for (const relayId of relayIds) {
          closed.push(relayId);
          // Mirror the endpoint's close event: socket ownership delegates
          // ordinary cleanup back to the registry rather than inventing a
          // second unregister path in the HTTP lifecycle controller.
          void relayRegistry.unregister(relayId);
        }
        return relayIds.length;
      },
    };
    const invalidator = createRelayPairingGenerationInvalidator({
      relayRegistry,
      workstationSessionRegistry: sessions,
      workstationDispatchPlanRegistry: plans,
      serverBindingId: "server-binding-a",
      socketLifecycle: sockets,
    });

    const result = invalidator.reconcileRevokedPairingGenerations({
      userId: "user-a",
      pairingGenerations: ["revoked-token-row"],
    });

    expect(result).toEqual({
      matchedLiveRelays: 1,
      invalidatedWorkstationSessions: 1,
      invalidatedDispatchPlans: 1,
      closedRelaySockets: 1,
    });
    expect(closed).toEqual(["relay-a"]);
    expect(sessions.get("user-a")).toBeNull();
    expect(plans.get("tool-call-a")).toBeNull();
    expect(await relayRegistry.listConnected()).toEqual([
      "relay-b",
      "relay-a-new-generation",
    ]);
    expect(plans.get("foreign-tool-call")?.relayId).toBe("relay-b");
  });

  test("does nothing for a generation that was not revoked", async () => {
    const relayRegistry = new InMemoryRelayRegistry();
    const sessions = new InMemoryWorkstationSessionRegistry();
    const plans = new InMemoryWorkstationDispatchPlanRegistry({
      ttlMs: Number.MAX_SAFE_INTEGER,
    });
    const closed: string[] = [];
    const invalidator = createRelayPairingGenerationInvalidator({
      relayRegistry,
      workstationSessionRegistry: sessions,
      workstationDispatchPlanRegistry: plans,
      serverBindingId: "server-binding-a",
      socketLifecycle: {
        closeRelays(relayIds) {
          closed.push(...relayIds);
          return relayIds.length;
        },
      },
    });

    expect(
      invalidator.reconcileRevokedPairingGenerations({
        userId: "user-a",
        pairingGenerations: ["not-live"],
      }),
    ).toEqual({
      matchedLiveRelays: 0,
      invalidatedWorkstationSessions: 0,
      invalidatedDispatchPlans: 0,
      closedRelaySockets: 0,
    });
    expect(closed).toEqual([]);
  });
});
