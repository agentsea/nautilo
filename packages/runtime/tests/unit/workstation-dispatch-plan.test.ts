/**
 * D418 task 3.1.2 — unit tests for the transient `WorkstationDispatchPlan`
 * admission store + the pure `revalidatePlanAgainstRelay` re-validation.
 *
 * These tests pin the admission-metadata contract:
 *   - the plan binds the exact binding tuple + tool-call id + execution class;
 *   - `get` is non-destructive (the network-egress retry path re-uses the
 *     same tool-call id) and lazily purges expired plans;
 *   - `invalidateForBinding` drops every plan bound to a relay binding;
 *   - `revalidatePlanAgainstRelay` fails closed on a disconnected relay and
 *     on every binding drift (subject / desktop session / capability revision
 *     / profile binding), and accepts only an exact fingerprint match.
 *
 * The plan never carries roots and never widens `allowedRoots` — there are
 * no root fields on the plan to assert here (the structural surface itself
 * is the contract). The tools-node pinning + `allowedRoots` non-widening is
 * covered by `packages/agent/tests/unit/workstation-dispatch-plan.test.ts`.
 */

import { describe, expect, it } from "bun:test";
import {
  InMemoryWorkstationDispatchPlanRegistry,
  revalidatePlanAgainstRelay,
  type WorkstationDispatchPlan,
  type WorkstationRelayFingerprint,
} from "../../src/workstation-dispatch-plan";

const FIXED_TS = "2026-07-13T12:00:00.000Z";
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
    currentFolder: "/Users/test/project",
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

describe("InMemoryWorkstationDispatchPlanRegistry — admit / get (D418 task 3.1.2)", () => {
  it("admits a plan keyed by toolCallId and returns it from get", () => {
    const registry = new InMemoryWorkstationDispatchPlanRegistry({ now: clock });
    registry.admit(plan());
    expect(registry.get("tc-1")).toEqual(plan());
    expect(registry.size()).toBe(1);
  });

  it("get is non-destructive (retry path re-uses the same toolCallId)", () => {
    const registry = new InMemoryWorkstationDispatchPlanRegistry({ now: clock });
    registry.admit(plan());
    registry.get("tc-1");
    registry.get("tc-1");
    expect(registry.get("tc-1")).toEqual(plan());
    expect(registry.size()).toBe(1);
  });

  it("returns null for an unknown / empty toolCallId", () => {
    const registry = new InMemoryWorkstationDispatchPlanRegistry({ now: clock });
    registry.admit(plan());
    expect(registry.get("tc-other")).toBeNull();
    expect(registry.get("")).toBeNull();
  });

  it("refuses to admit a plan with an empty toolCallId (cannot be keyed)", () => {
    const registry = new InMemoryWorkstationDispatchPlanRegistry({ now: clock });
    registry.admit(plan({ toolCallId: "" }));
    expect(registry.size()).toBe(0);
    expect(registry.get("")).toBeNull();
  });

  it("a duplicate admit for the same toolCallId overwrites with the freshest binding", () => {
    const registry = new InMemoryWorkstationDispatchPlanRegistry({ now: clock });
    registry.admit(plan());
    registry.admit(plan({ capabilityRevision: 11, profileRevision: 2 }));
    const got = registry.get("tc-1");
    expect(got?.capabilityRevision).toBe(11);
    expect(got?.profileRevision).toBe(2);
    expect(registry.size()).toBe(1);
  });

  it("the plan carries NO roots (admission metadata only, never Desktop filesystem authority)", () => {
    const registry = new InMemoryWorkstationDispatchPlanRegistry({ now: clock });
    registry.admit(plan());
    const got = registry.get("tc-1");
    if (!got) throw new Error("plan missing");
    // The plan surface is the contract: no roots / allowedRoots / sandbox
    // fields exist on a WorkstationDispatchPlan. Assert by key (not by
    // substring) because the `executionClass` value "profile_bound_sandbox"
    // legitimately contains the word "sandbox".
    const keys = new Set(Object.keys(got));
    expect(keys.has("allowedRoots")).toBe(false);
    expect(keys.has("roots")).toBe(false);
    expect(keys.has("sandboxProfile")).toBe(false);
    expect(keys.has("sandbox")).toBe(false);
  });
});

describe("InMemoryWorkstationDispatchPlanRegistry — TTL + invalidation", () => {
  it("lazily purges an expired plan on get", () => {
    let t = new Date("2026-07-13T12:00:00.000Z").getTime();
    const registry = new InMemoryWorkstationDispatchPlanRegistry({
      now: () => new Date(t),
      ttlMs: 60_000,
    });
    registry.admit(plan());
    expect(registry.get("tc-1")).not.toBeNull();
    // Advance past the TTL.
    t = new Date("2026-07-13T12:01:30.000Z").getTime();
    expect(registry.get("tc-1")).toBeNull();
    expect(registry.size()).toBe(0);
  });

  it("does not purge before the TTL elapses", () => {
    let t = new Date("2026-07-13T12:00:00.000Z").getTime();
    const registry = new InMemoryWorkstationDispatchPlanRegistry({
      now: () => new Date(t),
      ttlMs: 60_000,
    });
    registry.admit(plan());
    t = new Date("2026-07-13T12:00:59.000Z").getTime();
    expect(registry.get("tc-1")).not.toBeNull();
  });

  it("invalidate(toolCallId) drops one plan", () => {
    const registry = new InMemoryWorkstationDispatchPlanRegistry({ now: clock });
    registry.admit(plan({ toolCallId: "tc-1" }));
    registry.admit(plan({ toolCallId: "tc-2", relayId: "relay-B" }));
    registry.invalidate("tc-1");
    expect(registry.get("tc-1")).toBeNull();
    expect(registry.get("tc-2")).not.toBeNull();
  });

  it("invalidateForBinding drops every plan bound to that relay binding", () => {
    const registry = new InMemoryWorkstationDispatchPlanRegistry({ now: clock });
    registry.admit(plan({ toolCallId: "tc-1" }));
    registry.admit(plan({ toolCallId: "tc-2" }));
    registry.admit(
      plan({ toolCallId: "tc-3", relayId: "relay-B", desktopSessionId: "desktop-B" }),
    );
    const count = registry.invalidateForBinding({
      userId: "user-1",
      relayId: "relay-A",
      desktopSessionId: "desktop-session-1",
    });
    expect(count).toBe(2);
    expect(registry.get("tc-1")).toBeNull();
    expect(registry.get("tc-2")).toBeNull();
    expect(registry.get("tc-3")).not.toBeNull();
  });

  it("invalidateForBinding does NOT match on capabilityRevision (a bump still invalidates stale plans)", () => {
    const registry = new InMemoryWorkstationDispatchPlanRegistry({ now: clock });
    registry.admit(plan({ toolCallId: "tc-1", capabilityRevision: 10 }));
    const count = registry.invalidateForBinding({
      userId: "user-1",
      relayId: "relay-A",
      desktopSessionId: "desktop-session-1",
    });
    expect(count).toBe(1);
    expect(registry.get("tc-1")).toBeNull();
  });

  it("clear() drops every plan", () => {
    const registry = new InMemoryWorkstationDispatchPlanRegistry({ now: clock });
    registry.admit(plan({ toolCallId: "tc-1" }));
    registry.admit(plan({ toolCallId: "tc-2" }));
    registry.clear();
    expect(registry.size()).toBe(0);
  });
});

describe("revalidatePlanAgainstRelay (D418 task 3.1.2)", () => {
  it("accepts an exact fingerprint match", () => {
    expect(revalidatePlanAgainstRelay(plan(), fingerprint())).toEqual({ ok: true });
  });

  it("fails closed as relay_not_connected when the relay is gone (userId null)", () => {
    const r = revalidatePlanAgainstRelay(plan(), fingerprint({ userId: null }));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toBe("relay_not_connected");
  });

  it("fails closed as relay_not_connected when ANY fingerprint field is null", () => {
    for (const field of [
      "desktopSessionId",
      "capabilityRevision",
      "profileId",
      "profileRevision",
      "pairingGeneration",
    ] as const) {
      const r = revalidatePlanAgainstRelay(
        plan(),
        fingerprint({ [field]: null } as Partial<WorkstationRelayFingerprint>),
      );
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error("unreachable");
      expect(r.reason).toBe("relay_not_connected");
    }
  });

  it("rejects a user mismatch (relay re-paired to a foreign user)", () => {
    const r = revalidatePlanAgainstRelay(plan(), fingerprint({ userId: "foreign-user" }));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toBe("user_mismatch");
  });

  it("rejects a desktop session mismatch (app-restart identity change)", () => {
    const r = revalidatePlanAgainstRelay(
      plan(),
      fingerprint({ desktopSessionId: "desktop-session-other" }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toBe("desktop_session_mismatch");
  });

  it("rejects a capability revision mismatch (stale capability binding)", () => {
    const r = revalidatePlanAgainstRelay(plan(), fingerprint({ capabilityRevision: 11 }));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toBe("capability_revision_mismatch");
  });

  it("rejects a profile id mismatch (stale profile binding)", () => {
    const r = revalidatePlanAgainstRelay(plan(), fingerprint({ profileId: "profile-other" }));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toBe("profile_binding_mismatch");
  });

  it("rejects a profile revision mismatch (profile re-compile)", () => {
    const r = revalidatePlanAgainstRelay(plan(), fingerprint({ profileRevision: 2 }));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toBe("profile_binding_mismatch");
  });

  it("D418 Commit 2 — rejects a pairingGeneration mismatch (relay re-paired, desktopSessionId reused)", () => {
    const r = revalidatePlanAgainstRelay(plan(), fingerprint({ pairingGeneration: "pairing-re-paired" }));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    // Distinct reason label deferred to a follow-up that syncs the agent
    // mirror; reuses the binding-identity category, with the precise drift
    // in `detail`.
    expect(r.reason).toBe("desktop_session_mismatch");
    expect(r.detail).toContain("pairingGeneration");
  });

  it("the registry.revalidate method delegates to the pure function", () => {
    const registry = new InMemoryWorkstationDispatchPlanRegistry({ now: clock });
    expect(registry.revalidate(plan(), fingerprint())).toEqual({ ok: true });
    const r = registry.revalidate(plan(), fingerprint({ capabilityRevision: 99 }));
    expect(r.ok).toBe(false);
  });
});
