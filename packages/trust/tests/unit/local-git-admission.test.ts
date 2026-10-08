import { describe, expect, test } from "bun:test";
import { getToolPolicy } from "../../src/tool-policies";
import { resolveWorkstationAdmission, type WorkstationAdmissionEvidence } from "../../src/workstation-admission";

function evidence(overrides: Partial<WorkstationAdmissionEvidence> = {}): WorkstationAdmissionEvidence {
  return {
    executionClass: "typed_broker", exactPlan: true, tool: { name: "local_git", operation: "execute" },
    session: { userId: "human-fixture", instanceId: "instance-fixture", relayId: "relay-fixture",
      desktopSessionId: "desktop-fixture", serverBindingId: "server-fixture", agentScope: "all_owned_agents",
      profileId: "profile-fixture", profileRevision: 1, grantIds: ["grant-fixture"], capabilityRevision: 1,
      activatedAt: "2026-10-01T00:00:00.000Z" },
    ...overrides,
  };
}
describe("local Git admission", () => {
  test("retains destructive approval and distinct executor capability", () => {
    expect(getToolPolicy("local_git")).toEqual({ requiredCapability: "use_workstation", impact: "destructive",
      executor: "relay", relayCapability: "canUseLocalGit", requiresApproval: true });
  });
  test("only exact typed-broker session and plan can suppress the ordinary prompt", () => {
    expect(resolveWorkstationAdmission(evidence())).toEqual({ override: "auto", executionClass: "typed_broker" });
    for (const overrides of [{ session: null }, { exactPlan: false },
      { executionClass: "profile_bound_sandbox" as const }, { executionClass: "real_workstation" as const }]) {
      expect(resolveWorkstationAdmission(evidence(overrides)).override).toBe("none");
    }
  });
  test("the typed class does not admit another tool carrying Git arguments", () => {
    expect(resolveWorkstationAdmission(evidence({ tool: { name: "file", operation: "execute" } })).override).toBe("none");
  });
});
