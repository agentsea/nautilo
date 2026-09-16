/**
 * Stack 195 / W3.0.2 — unit coverage for the shared trust-layer
 * anti-escalation resolver. Pure policy tests with an injected
 * `AuthorityDeps` so no database is required.
 *
 * Coverage map (acceptance matrix in
 * `wave-3-stack-195-tasks.md` W3.0.2):
 *   - Admin → Owners add is rejected (insufficient_authority, missing the
 *     Owner-only caps the `owners` bundle grants).
 *   - Admin removing an Owner is rejected even with multiple Owners
 *     (reduction is not an exemption; add and remove share one gate).
 *   - Owner retains add/remove on a non-Owner Group (admins/superusers/
 *     members) because the Owner holds every cap in those bundles.
 *   - A delegated manager without `manage_members` is rejected with
 *     `missing_manage_members` even when the bundle would otherwise fit.
 *   - A non-existent Group yields `group_not_found`.
 *   - The nondelegable-capability ceiling rejects the Owner-only settings
 *     and security caps plus the Owner/Admin uncontained-host policy cap in
 *     a proposed custom-Role bundle even when the actor holds it.
 */
import { describe, expect, test } from "bun:test";
import {
  assertNoNondelegableCapabilities,
  authorizeMembershipMutation,
  checkAuthorityOverBundle,
  NONDELEGABLE_OWNER_ONLY_CAPABILITIES,
  type AuthorityDeps,
} from "../../src/rbac-anti-escalation";

// Canonical bundle facts (mirrors seed-trust-personal.ts ROLE_SEEDS /
// permission-model.md §6) so the unit suite does not import the DB seed.
const OWNER_BUNDLE = [
  "manage_server_operations",
  "manage_server_settings",
  "manage_server_security",
  "manage_uncontained_host_commands",
  "manage_members",
  "manage_groups",
  "manage_roles",
  "manage_agents",
  "view_audit_log",
  "use_workstation_profiles",
  "manage_workstation_profiles",
  "use_high_impact_tools",
  "use_terminal",
  "control_browser",
  "control_desktop",
];
// Admin = Owner MINUS the two Owner-only nondelegable caps.
const ADMIN_BUNDLE = OWNER_BUNDLE.filter(
  (c) => c !== "manage_server_settings" && c !== "manage_server_security",
);
const MEMBER_BUNDLE = [
  "use_workstation_profiles",
  "use_high_impact_tools",
];

function makeDeps(opts: {
  actorCaps: string[];
  hasManageMembers: boolean;
  groupBundle: { groupType: string; capabilities: string[] } | null;
}): AuthorityDeps {
  return {
    getUserCapabilities: async () => [...opts.actorCaps],
    userHasCapability: async (_userId, slug) =>
      slug === "manage_members" ? opts.hasManageMembers : opts.actorCaps.includes(slug),
    getGroupCapabilityBundle: async () =>
      opts.groupBundle === null ? null : { ...opts.groupBundle },
  };
}

describe("Stack 195 W3.0.2 — rbac-anti-escalation resolver", () => {
  test("rejects an Admin adding to the owners Group (insufficient_authority)", async () => {
    const decision = await authorizeMembershipMutation(
      makeDeps({
        actorCaps: ADMIN_BUNDLE,
        hasManageMembers: true,
        groupBundle: { groupType: "owners", capabilities: OWNER_BUNDLE },
      }),
      { actorUserId: "admin-1", targetGroupId: "g-owners", op: "add" },
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe("insufficient_authority");
      expect(decision.missing).toContain("manage_server_settings");
      expect(decision.missing).toContain("manage_server_security");
    }
  });

  test("rejects an Admin removing an Owner even when multiple Owners remain (reduction is not an exemption)", async () => {
    // The resolver is bundle-authority-only; it does not consult the
    // member count. The last-Owner rail is independent. So an Admin
    // removing ANY Owner is rejected on bundle authority alone.
    const decision = await authorizeMembershipMutation(
      makeDeps({
        actorCaps: ADMIN_BUNDLE,
        hasManageMembers: true,
        groupBundle: { groupType: "owners", capabilities: OWNER_BUNDLE },
      }),
      { actorUserId: "admin-1", targetGroupId: "g-owners", op: "remove" },
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe("insufficient_authority");
      expect(decision.missing).toContain("manage_server_security");
    }
  });

  test("an Owner retains add/remove on the owners Group (holds the full bundle)", async () => {
    for (const op of ["add", "remove"] as const) {
      const decision = await authorizeMembershipMutation(
        makeDeps({
          actorCaps: OWNER_BUNDLE,
          hasManageMembers: true,
          groupBundle: { groupType: "owners", capabilities: OWNER_BUNDLE },
        }),
        { actorUserId: "owner-1", targetGroupId: "g-owners", op },
      );
      expect(decision.ok).toBe(true);
      if (decision.ok) {
        expect(decision.bundle).toEqual(OWNER_BUNDLE);
      }
    }
  });

  test("an Owner retains non-owner membership operations (admins/superusers/members)", async () => {
    // The Owner holds every cap, so every canonical ladder Group bundle
    // is a subset of the Owner's caps. Add and remove both succeed.
    const groups = [
      { groupType: "admins", capabilities: ADMIN_BUNDLE },
      { groupType: "members", capabilities: MEMBER_BUNDLE },
      { groupType: "guests", capabilities: [] },
    ];
    for (const g of groups) {
      for (const op of ["add", "remove"] as const) {
        const decision = await authorizeMembershipMutation(
          makeDeps({
            actorCaps: OWNER_BUNDLE,
            hasManageMembers: true,
            groupBundle: g,
          }),
          { actorUserId: "owner-1", targetGroupId: `g-${g.groupType}`, op },
        );
        expect(decision.ok).toBe(true);
      }
    }
  });

  test("an Admin retains non-owner membership operations (admins/members)", async () => {
    // An Admin holds every cap in the admins and members bundles (those
    // bundles exclude the two Owner-only caps the Admin lacks), so the
    // Admin may administer those Groups — just not `owners`.
    for (const g of [
      { groupType: "admins", capabilities: ADMIN_BUNDLE },
      { groupType: "members", capabilities: MEMBER_BUNDLE },
    ]) {
      for (const op of ["add", "remove"] as const) {
        const decision = await authorizeMembershipMutation(
          makeDeps({
            actorCaps: ADMIN_BUNDLE,
            hasManageMembers: true,
            groupBundle: g,
          }),
          { actorUserId: "admin-1", targetGroupId: `g-${g.groupType}`, op },
        );
        expect(decision.ok).toBe(true);
      }
    }
  });

  test("rejects a delegated manager who lacks manage_members (missing_manage_members)", async () => {
    // A Superuser holds a strict subset of Admin (no manage_members) but
    // would otherwise hold the members bundle — the management gate fires
    // before bundle authority, so the reason is `missing_manage_members`.
    const superuserCaps = ADMIN_BUNDLE.filter((c) => c !== "manage_members");
    const decision = await authorizeMembershipMutation(
      makeDeps({
        actorCaps: superuserCaps,
        hasManageMembers: false,
        groupBundle: { groupType: "members", capabilities: MEMBER_BUNDLE },
      }),
      { actorUserId: "superuser-1", targetGroupId: "g-members", op: "add" },
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe("missing_manage_members");
      expect(decision.missing).toEqual([]);
    }
  });

  test("returns group_not_found for a missing target Group", async () => {
    const decision = await authorizeMembershipMutation(
      makeDeps({
        actorCaps: OWNER_BUNDLE,
        hasManageMembers: true,
        groupBundle: null,
      }),
      { actorUserId: "owner-1", targetGroupId: "no-such-group", op: "add" },
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe("group_not_found");
    }
  });

  test("treats a Group whose Roles carry no caps (guests) as an empty bundle an Owner may administer", async () => {
    const decision = await authorizeMembershipMutation(
      makeDeps({
        actorCaps: OWNER_BUNDLE,
        hasManageMembers: true,
        groupBundle: { groupType: "guests", capabilities: [] },
      }),
      { actorUserId: "owner-1", targetGroupId: "g-guests", op: "add" },
    );
    expect(decision.ok).toBe(true);
  });
});

describe("Stack 195 W3.0.2 — nondelegable-capability ceiling (pure)", () => {
  test("rejects manage_server_settings in a proposed custom-Role bundle", () => {
    const res = assertNoNondelegableCapabilities([
      "use_terminal",
      "manage_server_settings",
    ]);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("nondelegable_capability");
      expect(res.rejected).toEqual(["manage_server_settings"]);
    }
  });

  test("rejects manage_server_security in a proposed custom-Role bundle", () => {
    const res = assertNoNondelegableCapabilities(["manage_server_security"]);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("nondelegable_capability");
      expect(res.rejected).toEqual(["manage_server_security"]);
    }
  });

  test("rejects the Admin-capable uncontained-host policy in a proposed custom-Role bundle", () => {
    const res = assertNoNondelegableCapabilities(["manage_uncontained_host_commands"]);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("nondelegable_capability");
      expect(res.rejected).toEqual(["manage_uncontained_host_commands"]);
    }
  });

  test("accepts a bundle with no nondelegable caps (even an Owner cannot delegate these, but a bundle without them is fine)", () => {
    const res = assertNoNondelegableCapabilities([
      "use_terminal",
      "control_browser",
      "manage_members",
      "manage_server_operations",
    ]);
    expect(res.ok).toBe(true);
  });

  test("keeps the Admin-tier server-operations capability delegable", () => {
    expect(assertNoNondelegableCapabilities(["manage_server_operations"])).toEqual({
      ok: true,
    });
  });

  test("the legacy Owner-only subset remains exactly the two Owner-only caps", () => {
    expect([...NONDELEGABLE_OWNER_ONLY_CAPABILITIES]).toEqual([
      "manage_server_settings",
      "manage_server_security",
    ]);
  });
});

describe("Stack 195 W3.0.2 — checkAuthorityOverBundle (delegable-only-when-held)", () => {
  test("rejects a proposed bundle containing a cap the actor lacks", () => {
    const res = checkAuthorityOverBundle(
      ["use_terminal", "manage_members"],
      ["use_terminal", "control_browser"],
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("insufficient_authority");
      expect(res.missing).toEqual(["control_browser"]);
    }
  });

  test("accepts a proposed bundle that is a subset of the actor's caps", () => {
    const res = checkAuthorityOverBundle(
      ["use_terminal", "control_browser", "manage_members"],
      ["use_terminal", "control_browser"],
    );
    expect(res.ok).toBe(true);
  });

  test("an Admin proposing a bundle with manage_server_security is rejected on the held-cap axis too", () => {
    // Even setting aside the nondelegable ceiling, the Admin does not
    // hold manage_server_security, so the delegable authority check
    // rejects it. Both checks fire for the same cap in W3.2 preview.
    const res = checkAuthorityOverBundle(ADMIN_BUNDLE, [
      "use_terminal",
      "manage_server_security",
    ]);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.missing).toContain("manage_server_security");
    }
  });
});
