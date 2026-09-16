/**
 * D440 Phase 1 — revision-coherent plan fields + same-authority re-admission.
 *
 * Pins the Phase 1 additions to `WorkstationDispatchPlan` /
 * `WorkstationRelayFingerprint` (Current Folder, durable grant-store
 * revision, protected-policy version) and the
 * `InMemoryWorkstationDispatchPlanRegistry.readmit` same-authority
 * refresh path:
 *   - a grant-store / protected-policy drift between admission and dispatch
 *     fails closed (`grant_revision_mismatch` / `protected_policy_mismatch`);
 *   - the checks are skipped when either side is absent (backward-compat);
 *   - `readmit` re-admits a missing / TTL-expired plan ONLY for the exact
 *     same authority tuple; any drift returns `null` (fail closed, require
 *     fresh approval); an unwired `getActiveBinding` is a no-op.
 */

import { describe, expect, it } from "bun:test";
import {
  InMemoryWorkstationDispatchPlanRegistry,
  revalidatePlanAgainstRelay,
  type WorkstationDispatchPlan,
  type WorkstationDispatchPlanBindingSnapshot,
  type WorkstationRelayFingerprint,
} from "../../src/workstation-dispatch-plan";

const FIXED_TS = "2026-07-20T12:00:00.000Z";
const clock = () => new Date(FIXED_TS);

function plan(overrides: Partial<WorkstationDispatchPlan> = {}): WorkstationDispatchPlan {
  return {
    toolCallId: "tc-1",
    userId: "user-1",
    relayId: "relay-A",
    instanceId: "instance-1",
    desktopSessionId: "desktop-session-1",
    serverBindingId: "server-binding-1",
    pairingGeneration: "pairing-1",
    profileId: "profile-1",
    profileRevision: 1,
    grantIds: ["grant-1", "grant-2"],
    capabilityRevision: 10,
    executionClass: "profile_bound_sandbox",
    admittedAt: FIXED_TS,
    currentFolder: "/Users/d440/exact-project",
    grantRevision: 8,
    protectedPolicyVersion: 3,
    ...overrides,
  };
}

function fingerprint(
  overrides: Partial<WorkstationRelayFingerprint> = {},
): WorkstationRelayFingerprint {
  return {
    userId: "user-1",
    desktopSessionId: "desktop-session-1",
    capabilityRevision: 10,
    profileId: "profile-1",
    profileRevision: 1,
    pairingGeneration: "pairing-1",
    grantRevision: 8,
    protectedPolicyVersion: 3,
    ...overrides,
  };
}

function binding(
  overrides: Partial<WorkstationDispatchPlanBindingSnapshot> = {},
): WorkstationDispatchPlanBindingSnapshot {
  return {
    userId: "user-1",
    instanceId: "instance-1",
    relayId: "relay-A",
    desktopSessionId: "desktop-session-1",
    serverBindingId: "server-binding-1",
    pairingGeneration: "pairing-1",
    profileId: "profile-1",
    profileRevision: 1,
    grantIds: ["grant-1", "grant-2"],
    capabilityRevision: 10,
    grantRevision: 8,
    protectedPolicyVersion: 3,
    ...overrides,
  };
}

describe("D440 Phase 1 — revision-coherent revalidation", () => {
  it("accepts an exact fingerprint match including the new revision fields", () => {
    expect(revalidatePlanAgainstRelay(plan(), fingerprint())).toEqual({ ok: true });
  });

  it("rejects a grant-store revision mismatch (grant_revision_mismatch)", () => {
    const r = revalidatePlanAgainstRelay(plan(), fingerprint({ grantRevision: 9 }));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toBe("grant_revision_mismatch");
    expect(r.detail).toContain("grantRevision");
  });

  it("rejects a protected-policy version mismatch (protected_policy_mismatch)", () => {
    const r = revalidatePlanAgainstRelay(plan(), fingerprint({ protectedPolicyVersion: 4 }));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toBe("protected_policy_mismatch");
    expect(r.detail).toContain("protectedPolicyVersion");
  });

  it("rejects a profile-bound plan missing grant revision metadata", () => {
    const { grantRevision: _omit, ...planWithoutGrant } = plan();
    void _omit;
    expect(revalidatePlanAgainstRelay(planWithoutGrant, fingerprint())).toMatchObject({
      ok: false,
      reason: "binding_metadata_missing",
    });
  });

  it("rejects a profile-bound fingerprint missing protected-policy metadata", () => {
    const { protectedPolicyVersion: _omit, ...fpWithoutPpv } = fingerprint();
    void _omit;
    expect(revalidatePlanAgainstRelay(plan(), fpWithoutPpv)).toMatchObject({
      ok: false,
      reason: "binding_metadata_missing",
    });
  });
});

describe("D440 Phase 1 — InMemoryWorkstationDispatchPlanRegistry.readmit", () => {
  it("returns null when getActiveBinding is not wired (legacy / pre-D440 no-op)", () => {
    const registry = new InMemoryWorkstationDispatchPlanRegistry({ now: clock });
    expect(
      registry.readmit({
        toolCallId: "tc-refresh",
        userId: "user-1",
        currentFolder: "/Users/d440/exact-project",
        executionClass: "profile_bound_sandbox",
        fingerprint: fingerprint(),
      }),
    ).toBeNull();
    expect(registry.get("tc-refresh")).toBeNull();
  });

  it("re-admits a missing plan for the exact same authority tuple", () => {
    const active = binding();
    const registry = new InMemoryWorkstationDispatchPlanRegistry({
      now: clock,
      getActiveBinding: ({ userId }) => (userId === "user-1" ? active : null),
    });
    expect(registry.get("tc-refresh")).toBeNull();
    const readmitted = registry.readmit({
      toolCallId: "tc-refresh",
      userId: "user-1",
      currentFolder: "/Users/d440/exact-project",
      executionClass: "profile_bound_sandbox",
      fingerprint: fingerprint(),
    });
    expect(readmitted).not.toBeNull();
    if (!readmitted) throw new Error("unreachable");
    expect(readmitted.toolCallId).toBe("tc-refresh");
    expect(readmitted.relayId).toBe("relay-A");
    expect(readmitted.currentFolder).toBe("/Users/d440/exact-project");
    expect(readmitted.grantRevision).toBe(8);
    expect(readmitted.protectedPolicyVersion).toBe(3);
    expect(readmitted.admittedAt).toBe(FIXED_TS);
    // The re-admitted plan is now live in the registry.
    expect(registry.get("tc-refresh")).toEqual(readmitted);
  });

  it("fails closed (returns null) when the live binding drifted from the fingerprint", () => {
    const active = binding({ capabilityRevision: 11 });
    const registry = new InMemoryWorkstationDispatchPlanRegistry({
      now: clock,
      getActiveBinding: () => active,
    });
    // Fingerprint still advertises capabilityRevision 10 — authority drift.
    expect(
      registry.readmit({
        toolCallId: "tc-drift",
        userId: "user-1",
        currentFolder: "/Users/d440/exact-project",
        executionClass: "profile_bound_sandbox",
        fingerprint: fingerprint({ capabilityRevision: 10 }),
      }),
    ).toBeNull();
    expect(registry.get("tc-drift")).toBeNull();
  });

  it("fails closed (returns null) when the grant-store revision drifted", () => {
    const active = binding({ grantRevision: 9 });
    const registry = new InMemoryWorkstationDispatchPlanRegistry({
      now: clock,
      getActiveBinding: () => active,
    });
    expect(
      registry.readmit({
        toolCallId: "tc-grant-drift",
        userId: "user-1",
        currentFolder: "/Users/d440/exact-project",
        executionClass: "profile_bound_sandbox",
        fingerprint: fingerprint({ grantRevision: 8 }),
      }),
    ).toBeNull();
  });

  it("fails closed (returns null) when no active session exists", () => {
    const registry = new InMemoryWorkstationDispatchPlanRegistry({
      now: clock,
      getActiveBinding: () => null,
    });
    expect(
      registry.readmit({
        toolCallId: "tc-no-session",
        userId: "user-1",
        currentFolder: "/Users/d440/exact-project",
        executionClass: "profile_bound_sandbox",
        fingerprint: fingerprint(),
      }),
    ).toBeNull();
  });

  it("refuses to re-admit an empty toolCallId (cannot be keyed)", () => {
    const registry = new InMemoryWorkstationDispatchPlanRegistry({
      now: clock,
      getActiveBinding: () => binding(),
    });
    expect(
      registry.readmit({
        toolCallId: "",
        userId: "user-1",
        currentFolder: "/Users/d440/exact-project",
        executionClass: "profile_bound_sandbox",
        fingerprint: fingerprint(),
      }),
    ).toBeNull();
  });
});
