import { describe, it, expect, afterEach } from "bun:test";
import type { RelayCapabilities } from "@nautilo/relay";
import { setRelayRegistry, type ToolRelayRegistry } from "@nautilo/agent";
import { computeTaskRelayCapabilities } from "../../src/tasks/task-run-executor";

function fakeRegistry(
  byUser: Record<string, { id: string; caps: RelayCapabilities }[]>,
): ToolRelayRegistry {
  return {
    findByCapabilityForUser(capability: string, userId: string): string[] {
      return (byUser[userId] ?? [])
        .filter((r) => (r.caps as Record<string, unknown>)[capability] === true)
        .map((r) => r.id);
    },
    getCapabilities(relayId: string): RelayCapabilities | null {
      for (const relays of Object.values(byUser)) {
        const hit = relays.find((r) => r.id === relayId);
        if (hit) return hit.caps;
      }
      return null;
    },
    dispatch: (() => {
      throw new Error("not used");
    }) as unknown as ToolRelayRegistry["dispatch"],
  };
}

describe("computeTaskRelayCapabilities (M150)", () => {
  afterEach(() => {
    setRelayRegistry(null);
  });

  it("owner with a live canRunShell relay → exposes runtime readiness without Human authority", () => {
    setRelayRegistry(
      fakeRegistry({
        "owner-1": [{ id: "r1", caps: { profile: "desktop-agent", canRunShell: true } }],
      }),
    );

    const tokens = computeTaskRelayCapabilities("owner-1");

    expect(tokens).toBeDefined();
    expect(tokens?.["canRunShell"]).toBe(true);
    expect(tokens?.["use_workstation"]).toBeUndefined();
    expect(tokens?.["use_high_impact_tools"]).toBeUndefined();
  });

  it("owner with no relay → undefined (cloud-only)", () => {
    setRelayRegistry(fakeRegistry({}));

    expect(computeTaskRelayCapabilities("owner-1")).toBeUndefined();
  });

  it("no registry at all → undefined", () => {
    setRelayRegistry(null);

    expect(computeTaskRelayCapabilities("owner-1")).toBeUndefined();
  });

  it("keyed on ownerId, not a different user (peer-owned task)", () => {
    setRelayRegistry(
      fakeRegistry({
        "owner-1": [{ id: "r1", caps: { profile: "desktop-agent", canRunShell: true } }],
      }),
    );

    expect(computeTaskRelayCapabilities("owner-1")).toBeDefined();
    expect(computeTaskRelayCapabilities("requestor-2")).toBeUndefined();
  });
});
