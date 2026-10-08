import { describe, expect, test } from "bun:test";
import { resolveWorkstationAdmission, type WorkstationAdmissionEvidence } from "../../src/workstation-admission";

const session: NonNullable<WorkstationAdmissionEvidence["session"]> = {
  userId: "human-fixture", instanceId: "instance-fixture", relayId: "relay-fixture",
  desktopSessionId: "desktop-fixture", serverBindingId: "server-fixture", agentScope: "all_owned_agents",
  profileId: "profile-fixture", profileRevision: 1, grantIds: ["grant-fixture"], capabilityRevision: 1,
  activatedAt: "2026-10-06T00:00:00.000Z",
};
describe("managed execution contained admission", () => {
  test("requires an exact active contained plan and cannot borrow another execution class", () => {
    for (const name of ["exec_command", "write_stdin"]) {
      const evidence: WorkstationAdmissionEvidence = { executionClass: "profile_bound_sandbox", session, exactPlan: true, tool: { name, operation: "execute" } };
      expect(resolveWorkstationAdmission(evidence).override).toBe("auto");
      expect(resolveWorkstationAdmission({ ...evidence, session: null }).override).toBe("none");
      expect(resolveWorkstationAdmission({ ...evidence, exactPlan: false }).override).toBe("none");
      expect(resolveWorkstationAdmission({ ...evidence, executionClass: "real_workstation" }).override).toBe("none");
      expect(resolveWorkstationAdmission({ ...evidence, executionClass: "typed_broker" }).override).toBe("none");
    }
  });
});
