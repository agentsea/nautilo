/**
 * Stack 195 / W3.2 — unit coverage for the pure decision core of the RBAC
 * mutation engine (`evaluateOperation` + `computeFingerprint`). No
 * database: the state is built inline. The production preview/apply
 * wiring + live DB parity is covered in
 * `tests/integration/rbac-mutation-engine.integration.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import {
  CANONICAL_GROUP_TYPES,
  CANONICAL_ROLE_SLUGS,
  applyDirectOperation,
  applyOperation,
  computeFingerprint,
  evaluateOperation,
  managementCapabilityFor,
  managementCapabilitiesFor,
  UNCONTAINED_HOST_COMMANDS_GRANTEE_GROUP_TYPE,
  UNCONTAINED_HOST_COMMANDS_GRANTEE_ROLE_SLUG,
  type AccessControlOperation,
  type ApplyFacts,
  type ApplyResult,
  type EngineState,
  type MutationEngineDeps,
  type MutationTx,
  type RbacAuditEventInput,
  type WriteOutcome,
} from "../../src/rbac-mutation-engine";
import { MembershipOpError } from "../../src/queries";
import type { CapabilitySlug } from "../../src/capabilities";

const ALL_CAPS = [
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
const OWNER_BUNDLE = ALL_CAPS;
const ADMIN_BUNDLE = ALL_CAPS.filter(
  (c) => c !== "manage_server_settings" && c !== "manage_server_security",
);
// A synthetic manager who holds every delegable cap EXCEPT control_desktop,
// so authority-over-bundle checks can be exercised against a delegable cap
// the actor lacks (the real Admin holds every delegable cap).
const ADMIN_MINUS_DESKTOP = ADMIN_BUNDLE.filter((c) => c !== "control_desktop");
const MEMBER_BUNDLE = ["use_workstation_profiles", "use_high_impact_tools"];

function makeState(overrides: Partial<EngineState> = {}): EngineState {
  const base: EngineState = {
    roles: [
      { id: "r-owner", slug: "owner", label: "Owner", isSystem: true, capabilities: OWNER_BUNDLE },
      { id: "r-admin", slug: "admin", label: "Admin", isSystem: true, capabilities: ADMIN_BUNDLE },
      { id: "r-member", slug: "member", label: "Member", isSystem: true, capabilities: MEMBER_BUNDLE },
      { id: "r-guest", slug: "guest", label: "Guest", isSystem: true, capabilities: [] },
      {
        id: "r-uncontained-host-commands-grantee",
        slug: UNCONTAINED_HOST_COMMANDS_GRANTEE_ROLE_SLUG,
        label: "Uncontained Host Commands Grantee",
        isSystem: true,
        capabilities: [],
      },
      {
        id: "r-mobile",
        slug: "mobile-dev",
        label: "Mobile Dev",
        isSystem: false,
        capabilities: ["use_terminal", "control_browser"],
      },
      {
        id: "r-power",
        slug: "power-dev",
        label: "Power Dev",
        isSystem: false,
        capabilities: ["control_desktop", "use_terminal"],
      },
    ],
    groups: [
      {
        id: "g-owners",
        type: "owners",
        label: "Owners",
        isSystem: true,
        ownerId: null,
        roleSlugs: ["owner"],
        capabilities: OWNER_BUNDLE,
        members: ["u-owner", "u-owner2"],
        memberCount: 2,
        approvalChallengeCount: 0,
      },
      {
        id: "g-admins",
        type: "admins",
        label: "Admins",
        isSystem: true,
        ownerId: null,
        roleSlugs: ["admin"],
        capabilities: ADMIN_BUNDLE,
        members: ["u-admin"],
        memberCount: 1,
        approvalChallengeCount: 0,
      },
      {
        id: "g-members",
        type: "members",
        label: "Members",
        isSystem: true,
        ownerId: null,
        roleSlugs: ["member"],
        capabilities: MEMBER_BUNDLE,
        // u-ada is a Member AND a Mobile dev so source-aware deltas can be
        // exercised (a cap preserved by `members` stays UNCHANGED when the
        // custom Group membership is removed).
        members: ["u-ada", "u-ben", "u-carol", "u-dave", "u-eve"],
        memberCount: 5,
        approvalChallengeCount: 0,
      },
      {
        id: "g-mobile",
        type: "custom:mobile",
        label: "Mobile",
        isSystem: false,
        ownerId: "u-owner",
        roleSlugs: ["mobile-dev"],
        capabilities: ["use_terminal", "control_browser"],
        // u-ada and u-ben are also Members (so source-aware UNCHANGED deltas
        // can be exercised); u-fred is mobile-only (so a shared Permission-set
        // edit can exercise a genuinely ADDED delta for a cap the Human lacks).
        members: ["u-ada", "u-ben", "u-fred"],
        memberCount: 3,
        approvalChallengeCount: 2,
      },
      {
        id: "g-uncontained-host-commands-grantees",
        type: UNCONTAINED_HOST_COMMANDS_GRANTEE_GROUP_TYPE,
        label: "Uncontained Host Commands Grantees",
        isSystem: true,
        ownerId: null,
        roleSlugs: [UNCONTAINED_HOST_COMMANDS_GRANTEE_ROLE_SLUG],
        capabilities: [],
        members: [],
        memberCount: 0,
        approvalChallengeCount: 0,
      },
    ],
    knownCapabilities: ALL_CAPS,
  };
  return { ...base, ...overrides };
}

function evalOp(
  operation: AccessControlOperation,
  opts: {
    actorCaps?: readonly string[];
    actorHoldsManagement?: boolean;
    /** Defaults to all required caps when holding management, else empty. */
    actorHeldManagementCaps?: readonly CapabilitySlug[];
    targetUserExists?: boolean;
    state?: EngineState;
  } = {},
) {
  const state = opts.state ?? makeState();
  const required = managementCapabilitiesFor(operation, state);
  const actorHeldManagementCaps =
    opts.actorHeldManagementCaps ??
    (opts.actorHoldsManagement === false ? [] : [...required]);
  const actorHoldsManagement =
    opts.actorHoldsManagement ??
    required.every((cap) => actorHeldManagementCaps.includes(cap));
  return evaluateOperation({
    operation,
    state,
    actorCapabilities: opts.actorCaps ?? OWNER_BUNDLE,
    actorHoldsManagement,
    actorHeldManagementCaps,
    targetUserExists: opts.targetUserExists ?? true,
  });
}

function failureCodes(res: ReturnType<typeof evalOp>): string[] {
  return res.failures.map((f) => f.code);
}

describe("Community enrollment is unavailable until personal-funded chat is ready", () => {
  test("rejects direct membership in the canonical Group", () => {
    const base = makeState();
    const state = makeState({
      groups: [
        ...base.groups,
        {
          id: "g-communities",
          type: "communities",
          label: "Communities",
          isSystem: true,
          ownerId: null,
          roleSlugs: ["community"],
          capabilities: ["invoke_agents", "use_personal_provider_credentials"],
          members: [],
          memberCount: 0,
          approvalChallengeCount: 0,
        },
      ],
    });
    const result = evalOp({ kind: "membership.add", groupId: "g-communities", userId: "u-new" }, { state });
    expect(failureCodes(result)).toContain("community_enrollment_unavailable");
  });

  test("rejects enrollment through a legacy custom Group carrying Community", () => {
    const base = makeState();
    const state = makeState({
      groups: base.groups.map((group) => group.id === "g-mobile"
        ? { ...group, roleSlugs: ["community"], members: [], memberCount: 0 }
        : group),
    });
    const result = evalOp({ kind: "membership.add", groupId: "g-mobile", userId: "u-new" }, { state });
    expect(failureCodes(result)).toContain("community_enrollment_unavailable");
  });

  test("rejects applying Community to an occupied Group", () => {
    const base = makeState();
    const state = makeState({
      groups: base.groups.map((group) => group.id === "g-mobile"
        ? { ...group, roleSlugs: ["mobile-dev"], members: ["u-ada"], memberCount: 1 }
        : group),
    });
    const result = evalOp({ kind: "group.set_roles", groupId: "g-mobile", roleSlugs: ["community"] }, { state });
    expect(failureCodes(result)).toContain("community_enrollment_unavailable");
  });
});

describe("Stack 195 W3.2 — managementCapabilityFor / managementCapabilitiesFor", () => {
  test("role.* → manage_roles, group.* → manage_groups, membership.* → manage_members", () => {
    expect(managementCapabilityFor({ kind: "role.create", slug: "x", label: "X", capabilities: [] })).toBe("manage_roles");
    expect(managementCapabilityFor({ kind: "role.delete", roleId: "r" })).toBe("manage_roles");
    expect(managementCapabilityFor({ kind: "group.create", groupType: "custom:x", label: "X", ownerUserId: "u", roleSlugs: [] })).toBe("manage_groups");
    expect(managementCapabilityFor({ kind: "group.delete", groupId: "g" })).toBe("manage_groups");
    expect(managementCapabilityFor({ kind: "membership.add", groupId: "g", userId: "u" })).toBe("manage_members");
    expect(managementCapabilityFor({ kind: "membership.remove", groupId: "g", userId: "u" })).toBe("manage_members");
  });

  test("managementCapabilitiesFor returns a single cap for existing ops", () => {
    expect(managementCapabilitiesFor({ kind: "role.create", slug: "x", label: "X", capabilities: [] })).toEqual(["manage_roles"]);
    expect(managementCapabilitiesFor({ kind: "group.delete", groupId: "g" })).toEqual(["manage_groups"]);
    expect(managementCapabilitiesFor({ kind: "membership.add", groupId: "g", userId: "u" })).toEqual(["manage_members"]);
  });

  test("protected grant-group membership requires manage_members plus its narrow manager cap", () => {
    const operation = {
      kind: "membership.add" as const,
      groupId: "g-uncontained-host-commands-grantees",
      userId: "u-new",
    };
    expect(managementCapabilitiesFor(operation, makeState())).toEqual([
      "manage_members",
      "manage_uncontained_host_commands",
    ]);
    expect(managementCapabilitiesFor({ ...operation, kind: "membership.remove" }, makeState())).toEqual([
      "manage_members",
      "manage_uncontained_host_commands",
    ]);
    expect(managementCapabilitiesFor({ ...operation, groupId: "g-mobile" }, makeState())).toEqual([
      "manage_members",
    ]);
  });

  test("managementCapabilitiesFor requires ALL THREE caps for shared_access.create", () => {
    expect(
      managementCapabilitiesFor({
        kind: "shared_access.create",
        role: { slug: "x", label: "X", capabilities: [] },
        group: { groupType: "custom:x", label: "X", ownerUserId: "u" },
        memberUserIds: ["u"],
      }),
    ).toEqual(["manage_roles", "manage_groups", "manage_members"]);
  });

  test("managementCapabilitiesFor requires manage_groups + manage_members (NOT manage_roles) for shared_access.assign_existing", () => {
    expect(
      managementCapabilitiesFor({
        kind: "shared_access.assign_existing",
        roleSlug: "mobile-dev",
        group: { groupType: "custom:x", label: "X", ownerUserId: "u" },
        memberUserIds: ["u"],
      }),
    ).toEqual(["manage_groups", "manage_members"]);
  });
});

describe("Stack 195 W3.2 — role.create", () => {
  test("authorized Owner creates a custom role", () => {
    const res = evalOp({ kind: "role.create", slug: "qa", label: "QA", capabilities: ["use_terminal"] });
    expect(res.ok).toBe(true);
    expect(res.authorityDelta?.added).toEqual(["use_terminal"]);
    expect(res.proposedAuthority).toEqual(["use_terminal"]);
    expect(res.auditPreview.kind).toBe("rbac_role_created");
  });

  test("reserved canonical slug rejected", () => {
    const res = evalOp({ kind: "role.create", slug: "admin", label: "A", capabilities: [] });
    expect(res.ok).toBe(false);
    expect(failureCodes(res)).toContain("reserved_slug");
  });

  test("protected uncontained-host-command Role slug is reserved", () => {
    const res = evalOp({
      kind: "role.create",
      slug: UNCONTAINED_HOST_COMMANDS_GRANTEE_ROLE_SLUG,
      label: "Imposter",
      capabilities: [],
    });
    expect(res.ok).toBe(false);
    expect(failureCodes(res)).toContain("reserved_slug");
  });

  test("nondelegable cap rejected even for an Owner", () => {
    const res = evalOp({
      kind: "role.create",
      slug: "qa",
      label: "QA",
      capabilities: ["manage_server_security"],
    });
    expect(res.ok).toBe(false);
    expect(failureCodes(res)).toContain("nondelegable_capability");
  });

  test("Admin-held uncontained-host policy remains nondelegable", () => {
    const res = evalOp(
      {
        kind: "role.create",
        slug: "host-policy-delegation",
        label: "Host Policy Delegation",
        capabilities: ["manage_uncontained_host_commands"],
      },
      { actorCaps: ADMIN_BUNDLE },
    );
    expect(res.ok).toBe(false);
    expect(failureCodes(res)).toContain("nondelegable_capability");
  });

  test("unknown capability rejected", () => {
    const res = evalOp({ kind: "role.create", slug: "qa", label: "QA", capabilities: ["not_a_cap"] });
    expect(res.ok).toBe(false);
    expect(failureCodes(res)).toContain("unknown_capability");
  });

  test("actor lacking a cap in the proposed bundle is rejected", () => {
    const res = evalOp(
      { kind: "role.create", slug: "qa", label: "QA", capabilities: ["control_desktop"] },
      { actorCaps: ADMIN_MINUS_DESKTOP },
    );
    expect(res.ok).toBe(false);
    expect(failureCodes(res)).toContain("insufficient_authority");
  });

  test("missing manage_roles rejected", () => {
    const res = evalOp(
      { kind: "role.create", slug: "qa", label: "QA", capabilities: ["use_terminal"] },
      { actorHoldsManagement: false },
    );
    expect(res.ok).toBe(false);
    expect(failureCodes(res)).toContain("missing_manage_roles");
  });
});

describe("Stack 195 W3.2 — role.rename / set_capabilities / delete", () => {
  test("system role rename rejected (protected_definition)", () => {
    const res = evalOp({ kind: "role.rename", roleId: "r-admin", label: "New" });
    expect(res.ok).toBe(false);
    expect(failureCodes(res)).toContain("protected_definition");
  });

  test("custom role rename by an authorized actor ok", () => {
    const res = evalOp({ kind: "role.rename", roleId: "r-mobile", label: "Mobile Team" });
    expect(res.ok).toBe(true);
    expect(res.auditPreview.kind).toBe("rbac_role_renamed");
  });

  test("set_capabilities requires authority over current AND proposed", () => {
    // Actor lacks control_desktop (proposed) → rejected even though they
    // hold the role's current bundle (use_terminal + control_browser).
    const res = evalOp(
      { kind: "role.set_capabilities", roleId: "r-mobile", capabilities: ["use_terminal", "control_desktop"] },
      { actorCaps: ADMIN_MINUS_DESKTOP },
    );
    expect(res.ok).toBe(false);
    expect(failureCodes(res)).toContain("insufficient_authority");
  });

  test("set_capabilities by Owner ok with delta", () => {
    const res = evalOp({
      kind: "role.set_capabilities",
      roleId: "r-mobile",
      capabilities: ["use_terminal", "use_high_impact_tools"],
    });
    expect(res.ok).toBe(true);
    expect(res.authorityDelta?.added).toEqual(["use_high_impact_tools"]);
    expect(res.authorityDelta?.removed).toEqual(["control_browser"]);
    expect(res.currentAuthority).toEqual(["use_terminal", "control_browser"]);
  });

  test("set_capabilities rejects nondelegable cap", () => {
    const res = evalOp({
      kind: "role.set_capabilities",
      roleId: "r-mobile",
      capabilities: ["manage_server_settings"],
    });
    expect(res.ok).toBe(false);
    expect(failureCodes(res)).toContain("nondelegable_capability");
  });

  test("set_capabilities rejects the Admin-held uncontained-host policy", () => {
    const res = evalOp(
      {
        kind: "role.set_capabilities",
        roleId: "r-mobile",
        capabilities: ["manage_uncontained_host_commands"],
      },
      { actorCaps: ADMIN_BUNDLE },
    );
    expect(res.ok).toBe(false);
    expect(failureCodes(res)).toContain("nondelegable_capability");
  });

  test("role.delete on system role rejected; custom ok with consequence", () => {
    const sys = evalOp({ kind: "role.delete", roleId: "r-admin" });
    expect(sys.ok).toBe(false);
    expect(failureCodes(sys)).toContain("protected_definition");

    const ok = evalOp({ kind: "role.delete", roleId: "r-mobile" });
    expect(ok.ok).toBe(true);
    expect(ok.deletionConsequence?.targetKind).toBe("role");
    expect(ok.deletionConsequence?.groupRolesRemoved).toBe(1);
    expect(ok.deletionConsequence?.affectedGroups?.[0]?.groupType).toBe("custom:mobile");
  });

  test("role.delete by a manager on a stronger custom role is rejected (reduction not exempt)", () => {
    // r-power bundles control_desktop which the actor lacks → rejected.
    const res = evalOp(
      { kind: "role.delete", roleId: "r-power" },
      { actorCaps: ADMIN_MINUS_DESKTOP },
    );
    expect(res.ok).toBe(false);
    expect(failureCodes(res)).toContain("insufficient_authority");
  });
});

describe("Stack 195 W3.2 — group.create / rename / set_roles / transfer / delete", () => {
  test("authorized Owner creates a custom group with a custom role", () => {
    const res = evalOp({
      kind: "group.create",
      groupType: "custom:qa",
      label: "QA",
      ownerUserId: "u-owner",
      roleSlugs: ["mobile-dev"],
    });
    expect(res.ok).toBe(true);
    expect(res.proposedAuthority).toEqual(["use_terminal", "control_browser"]);
    expect(res.auditPreview.kind).toBe("rbac_group_created");
  });

  test("reserved canonical group type rejected", () => {
    const res = evalOp({
      kind: "group.create",
      groupType: "members",
      label: "M",
      ownerUserId: "u-owner",
      roleSlugs: [],
    });
    expect(res.ok).toBe(false);
    expect(failureCodes(res)).toContain("reserved_type");
  });

  test("non-custom type rejected (invalid_custom_type)", () => {
    const res = evalOp({
      kind: "group.create",
      groupType: "qa",
      label: "QA",
      ownerUserId: "u-owner",
      roleSlugs: [],
    });
    expect(res.ok).toBe(false);
    expect(failureCodes(res)).toContain("invalid_custom_type");
  });

  test("canonical role assignment to a custom group rejected", () => {
    const res = evalOp({
      kind: "group.create",
      groupType: "custom:qa",
      label: "QA",
      ownerUserId: "u-owner",
      roleSlugs: ["admin"],
    });
    expect(res.ok).toBe(false);
    expect(failureCodes(res)).toContain("protected_definition");
  });

  test("missing owner rejected", () => {
    const res = evalOp(
      {
        kind: "group.create",
        groupType: "custom:qa",
        label: "QA",
        ownerUserId: "u-missing",
        roleSlugs: [],
      },
      { targetUserExists: false },
    );
    expect(res.ok).toBe(false);
    expect(failureCodes(res)).toContain("user_not_found");
  });

  test("system group rename / delete rejected (protected_definition)", () => {
    const rename = evalOp({ kind: "group.rename", groupId: "g-admins", label: "New" });
    expect(rename.ok).toBe(false);
    expect(failureCodes(rename)).toContain("protected_definition");
    const del = evalOp({ kind: "group.delete", groupId: "g-admins" });
    expect(del.ok).toBe(false);
    expect(failureCodes(del)).toContain("protected_definition");
  });

  test("custom group delete ok with approval-challenge consequence", () => {
    const res = evalOp({ kind: "group.delete", groupId: "g-mobile" });
    expect(res.ok).toBe(true);
    expect(res.deletionConsequence?.targetKind).toBe("group");
    expect(res.deletionConsequence?.membersRemoved).toBe(3);
    expect(res.deletionConsequence?.approvalChallengesRemoved).toBe(2);
    expect(res.deletionConsequence?.roleAssignmentsRemoved).toBe(1);
  });

  test("group.transfer_owner requires a valid new owner + authority over bundle", () => {
    const ok = evalOp({ kind: "group.transfer_owner", groupId: "g-mobile", newOwnerUserId: "u-other" });
    expect(ok.ok).toBe(true);
    expect(ok.auditPreview.kind).toBe("rbac_group_owner_transferred");
    const missing = evalOp(
      { kind: "group.transfer_owner", groupId: "g-mobile", newOwnerUserId: "u-missing" },
      { targetUserExists: false },
    );
    expect(missing.ok).toBe(false);
    expect(failureCodes(missing)).toContain("user_not_found");
  });
});

describe("Stack 195 W3.2 — membership.add / remove", () => {
  test("protected grant-group membership requires both management capabilities", () => {
    const operation = {
      kind: "membership.add" as const,
      groupId: "g-uncontained-host-commands-grantees",
      userId: "u-new",
    };
    const missingNarrowCap = evalOp(operation, {
      actorHeldManagementCaps: ["manage_members"],
    });
    expect(missingNarrowCap.ok).toBe(false);
    expect(failureCodes(missingNarrowCap)).not.toContain("missing_manage_members");
    expect(failureCodes(missingNarrowCap)).toContain(
      "missing_manage_uncontained_host_commands",
    );

    const allowed = evalOp(operation, {
      actorHeldManagementCaps: [
        "manage_members",
        "manage_uncontained_host_commands",
      ],
    });
    expect(allowed.ok).toBe(true);
  });

  test("unrelated membership remains gated by manage_members alone", () => {
    const res = evalOp(
      { kind: "membership.add", groupId: "g-mobile", userId: "u-new" },
      { actorHeldManagementCaps: ["manage_members"] },
    );
    expect(res.ok).toBe(true);
  });

  test("Admin adding to the owners Group is rejected (insufficient_authority)", () => {
    const res = evalOp(
      { kind: "membership.add", groupId: "g-owners", userId: "u-new" },
      { actorCaps: ADMIN_BUNDLE },
    );
    expect(res.ok).toBe(false);
    expect(failureCodes(res)).toContain("insufficient_authority");
    expect(res.failures.find((f) => f.code === "insufficient_authority")?.missing).toContain("manage_server_security");
  });

  test("Owner adding to owners Group ok with affectedUserDelta", () => {
    const res = evalOp({ kind: "membership.add", groupId: "g-owners", userId: "u-new" });
    expect(res.ok).toBe(true);
    // u-new holds nothing today, so the true effective delta adds the whole
    // owner bundle (sorted, since effective unions are sorted).
    expect(res.affectedUserDelta?.added).toEqual([...OWNER_BUNDLE].sort());
    expect(res.affectedUserDelta?.removed).toEqual([]);
    expect(res.affectedUserDelta?.unchanged).toEqual([]);
    expect(res.auditPreview.kind).toBe("group_member_added");
  });

  test("membership.remove is source-aware: a cap preserved by another Group is UNCHANGED, not removed", () => {
    // u-ada is in g-mobile (use_terminal, control_browser) AND g-members
    // (use_workstation_profiles, use_high_impact_tools). Removing u-ada
    // from g-mobile drops only the mobile caps; the Member caps are
    // preserved by g-members → UNCHANGED.
    const res = evalOp({ kind: "membership.remove", groupId: "g-mobile", userId: "u-ada" });
    expect(res.ok).toBe(true);
    expect(res.affectedUserDelta?.userId).toBe("u-ada");
    expect(res.affectedUserDelta?.added).toEqual([]);
    expect(res.affectedUserDelta?.removed).toEqual(["control_browser", "use_terminal"]);
    expect(res.affectedUserDelta?.unchanged).toEqual([...MEMBER_BUNDLE].sort());
  });

  test("membership.add is source-aware: adding a cap the user already holds is UNCHANGED, not ADDED", () => {
    // u-ada already holds use_workstation_profiles via g-members. Adding
    // u-ada to a group that grants use_workstation_profiles adds nothing
    // new for that cap (it's UNCHANGED). Use a fresh custom group for it.
    const state = makeState({
      groups: [
        ...makeState().groups,
        {
          id: "g-wp",
          type: "custom:wp",
          label: "WP",
          isSystem: false,
          ownerId: "u-owner",
          roleSlugs: ["mobile-dev"],
          capabilities: ["use_terminal", "control_browser"],
          members: [],
          memberCount: 0,
          approvalChallengeCount: 0,
        },
      ],
    });
    // mobile-dev bundles use_terminal + control_browser; u-ada already has
    // both via g-mobile, so adding to g-wp changes nothing effectively.
    const res = evalOp(
      { kind: "membership.add", groupId: "g-wp", userId: "u-ada" },
      { state },
    );
    expect(res.ok).toBe(true);
    expect(res.affectedUserDelta?.added).toEqual([]);
    expect(res.affectedUserDelta?.removed).toEqual([]);
    expect(res.affectedUserDelta?.unchanged).toEqual(
      [...new Set([...MEMBER_BUNDLE, "use_terminal", "control_browser"])].sort(),
    );
  });

  test("Admin removing an Owner is rejected (reduction is not an exemption)", () => {
    const res = evalOp(
      { kind: "membership.remove", groupId: "g-owners", userId: "u-owner2" },
      { actorCaps: ADMIN_BUNDLE },
    );
    expect(res.ok).toBe(false);
    expect(failureCodes(res)).toContain("insufficient_authority");
  });

  test("missing manage_members rejected", () => {
    const res = evalOp(
      { kind: "membership.add", groupId: "g-members", userId: "u-new" },
      { actorHoldsManagement: false },
    );
    expect(res.ok).toBe(false);
    expect(failureCodes(res)).toContain("missing_manage_members");
  });

  test("audit preview never carries secret material (only identifiers + slugs)", () => {
    const res = evalOp({ kind: "membership.remove", groupId: "g-mobile", userId: "u-x", });
    const json = JSON.stringify(res.auditPreview);
    expect(json).not.toContain("pin");
    expect(json).not.toContain("token");
    expect(json).not.toContain("secret");
  });
});

describe("Stack 195 W3.2 — computeFingerprint", () => {
  test("deterministic for the same state", () => {
    const s = makeState();
    expect(computeFingerprint(s)).toBe(computeFingerprint(s));
  });

  test("changes when a membership edge drifts (count changes)", () => {
    const s1 = makeState();
    const s2 = makeState({
      groups: s1.groups.map((g) =>
        g.id === "g-owners"
          ? { ...g, members: [...g.members, "u-new"].sort(), memberCount: g.memberCount + 1 }
          : g,
      ),
    });
    expect(computeFingerprint(s1)).not.toBe(computeFingerprint(s2));
  });

  test("changes when a membership SWAP keeps the same count (exact edges, not just counts)", () => {
    const s1 = makeState();
    // Swap u-owner2 out and u-z in on g-owners: count stays 2, but the edge
    // set differs, so the fingerprint MUST change.
    const s2 = makeState({
      groups: s1.groups.map((g) =>
        g.id === "g-owners"
          ? { ...g, members: ["u-owner", "u-z"].sort(), memberCount: g.memberCount }
          : g,
      ),
    });
    expect(computeFingerprint(s1)).not.toBe(computeFingerprint(s2));
  });

  test("memberCount alone (without an edge change) does NOT change the fingerprint", () => {
    const s1 = makeState();
    const s2 = makeState({
      groups: s1.groups.map((g) =>
        g.id === "g-owners" ? { ...g, memberCount: g.memberCount + 1 } : g,
      ),
    });
    expect(computeFingerprint(s1)).toBe(computeFingerprint(s2));
  });

  test("changes when a role bundle drifts", () => {
    const s1 = makeState();
    const s2 = makeState({
      roles: s1.roles.map((r) => (r.id === "r-mobile" ? { ...r, capabilities: ["use_terminal"] } : r)),
    });
    expect(computeFingerprint(s1)).not.toBe(computeFingerprint(s2));
  });

  test("prefixed opaque form", () => {
    expect(computeFingerprint(makeState()).startsWith("v1:")).toBe(true);
  });
});

describe("Stack 195 W3.2 — canonical sets", () => {
  test("six canonical role slugs and group types", () => {
    expect([...CANONICAL_ROLE_SLUGS]).toEqual(["owner", "admin", "superuser", "member", "contributor", "community", "guest"]);
    expect([...CANONICAL_GROUP_TYPES]).toEqual(["owners", "admins", "superusers", "members", "contributors", "communities", "guests"]);
  });
});

// ---------------------------------------------------------------------------
// runApply branches (applyOperation / applyDirectOperation) — DB-free via a
// mock MutationEngineDeps. Covers: ok + auditRecorded:true; ok +
// auditRecorded:false (audit append throws); stale_preview; denied. The
// real-DB parity for these branches is in the integration suite.
// ---------------------------------------------------------------------------

function mockDeps(opts: {
  state?: EngineState;
  actorCaps?: readonly string[];
  auditSink?: (payload: RbacAuditEventInput) => void;
  executeCalls?: AccessControlOperation[];
  writeOutcome?: WriteOutcome;
  applyFacts?: Partial<ApplyFacts>;
  applyFactCalls?: { tx: MutationTx; actorUserId: string; requiredManagementCapabilities: readonly string[]; targetUserIds: readonly string[] | null }[];
  transactionTx?: MutationTx;
  rejectNonTransactionalHooks?: boolean;
  applyTxError?: Error & { code?: string };
}): MutationEngineDeps {
  const state = opts.state ?? makeState();
  const deps: MutationEngineDeps = {
    async getActorCapabilities(_userId) {
      if (opts.rejectNonTransactionalHooks) throw new Error("shared-pool capability hook called");
      return [...(opts.actorCaps ?? OWNER_BUNDLE)];
    },
    async userHasCapability(_userId, _slug) {
      if (opts.rejectNonTransactionalHooks) throw new Error("shared-pool management hook called");
      return true;
    },
    async userExists(_userId) {
      if (opts.rejectNonTransactionalHooks) throw new Error("shared-pool user-exists hook called");
      return true;
    },
    async loadState() {
      return state;
    },
    async loadApplyFacts(tx, input) {
      opts.applyFactCalls?.push({
        tx,
        actorUserId: input.actorUserId,
        requiredManagementCapabilities: input.requiredManagementCapabilities,
        targetUserIds: input.targetUserIds,
      });
      const required = input.requiredManagementCapabilities;
      const actorCaps = opts.applyFacts?.actorCapabilities ?? [...(opts.actorCaps ?? OWNER_BUNDLE)];
      const held = required.filter((c) => actorCaps.includes(c));
      return {
        actorCapabilities: actorCaps,
        actorHeldManagementCaps: opts.applyFacts?.actorHeldManagementCaps ?? held,
        actorHoldsManagement: opts.applyFacts?.actorHoldsManagement ?? (held.length === required.length),
        targetUserExists: opts.applyFacts?.targetUserExists ?? true,
      };
    },
    async applyInTx<T>(fn: (tx: MutationTx, s: EngineState) => Promise<T>): Promise<T> {
      if (opts.applyTxError) throw opts.applyTxError;
      return fn(opts.transactionTx ?? (null as unknown as MutationTx), state);
    },
    async execute(_tx, op) {
      opts.executeCalls?.push(op);
      return opts.writeOutcome ?? {};
    },
    appendAuditEvent(payload) {
      if (opts.auditSink) opts.auditSink(payload);
    },
  };
  return deps;
}

describe("Stack 195 W3.2 — runApply branches (mock deps)", () => {
  const okOp: AccessControlOperation = {
    kind: "role.create",
    slug: `mock-${Date.now().toString(36)}`,
    label: "Mock",
    capabilities: ["use_terminal"],
  };

  test("applyOperation ok → applied:true, auditRecorded:true, execute ran", async () => {
    const fingerprint = computeFingerprint(makeState());
    const execCalls: AccessControlOperation[] = [];
    const res = await applyOperation(mockDeps({ executeCalls: execCalls }), {
      actorUserId: "u-actor",
      actorActorId: "a-actor",
      operation: okOp,
      fingerprint,
    });
    expect(res.applied).toBe(true);
    if (res.applied) {
      expect(res.auditRecorded).toBe(true);
      expect(res.fingerprint).toBe(fingerprint);
    }
    expect(execCalls.length).toBe(1);
  });

  test("applyOperation reads actor facts through its transaction, never shared-pool hooks", async () => {
    const transactionTx = { scope: "transaction-only" } as unknown as MutationTx;
    const factCalls: {
      tx: MutationTx;
      actorUserId: string;
      requiredManagementCapabilities: readonly string[];
      targetUserIds: readonly string[] | null;
    }[] = [];
    const res = await applyOperation(
      mockDeps({
        transactionTx,
        applyFactCalls: factCalls,
        rejectNonTransactionalHooks: true,
      }),
      {
        actorUserId: "u-actor",
        actorActorId: "a-actor",
        operation: okOp,
        fingerprint: computeFingerprint(makeState()),
      },
    );
    expect(res.applied).toBe(true);
    expect(factCalls).toEqual([
      {
        tx: transactionTx,
        actorUserId: "u-actor",
        requiredManagementCapabilities: ["manage_roles"],
        targetUserIds: null,
      },
    ]);
  });

  test("applyDirectOperation also reads membership target existence through its transaction", async () => {
    const transactionTx = { scope: "transaction-only" } as unknown as MutationTx;
    const factCalls: {
      tx: MutationTx;
      actorUserId: string;
      requiredManagementCapabilities: readonly string[];
      targetUserIds: readonly string[] | null;
    }[] = [];
    const res = await applyDirectOperation(
      mockDeps({
        transactionTx,
        applyFactCalls: factCalls,
        rejectNonTransactionalHooks: true,
      }),
      {
        actorUserId: "u-actor",
        actorActorId: "a-actor",
        operation: { kind: "membership.add", groupId: "g-members", userId: "u-target" },
      },
    );
    expect(res.applied).toBe(true);
    expect(factCalls).toEqual([
      {
        tx: transactionTx,
        actorUserId: "u-actor",
        requiredManagementCapabilities: ["manage_members"],
        targetUserIds: ["u-target"],
      },
    ]);
  });

  test("applyOperation audit append throws → applied:true, auditRecorded:false", async () => {
    const fingerprint = computeFingerprint(makeState());
    const res = await applyOperation(
      mockDeps({ auditSink: () => { throw new Error("disk full"); } }),
      { actorUserId: "u-actor", actorActorId: "a-actor", operation: okOp, fingerprint },
    );
    expect(res.applied).toBe(true);
    if (res.applied) expect(res.auditRecorded).toBe(false);
  });

  test("applyOperation stale fingerprint → applied:false, code stale_preview, no execute", async () => {
    const execCalls: AccessControlOperation[] = [];
    const res = await applyOperation(mockDeps({ executeCalls: execCalls }), {
      actorUserId: "u-actor",
      actorActorId: "a-actor",
      operation: okOp,
      fingerprint: "v1:WRONG",
    });
    expect(res.applied).toBe(false);
    if (!res.applied) expect(res.code).toBe("stale_preview");
    expect(execCalls.length).toBe(0);
  });

  test("applyOperation turns a SERIALIZABLE conflict into stale_preview", async () => {
    const res = await applyOperation(
      mockDeps({ applyTxError: Object.assign(new Error("serialization failure"), { code: "40001" }) }),
      {
        actorUserId: "u-actor",
        actorActorId: "a-actor",
        operation: okOp,
        fingerprint: computeFingerprint(makeState()),
      },
    );
    expect(res).toEqual({
      applied: false,
      code: "stale_preview",
      failures: [],
      reason: "state changed while applying preview",
    });
  });

  test("applyOperation denied (nondelegable cap) → applied:false, code authorization_denied, no execute", async () => {
    const execCalls: AccessControlOperation[] = [];
    const fingerprint = computeFingerprint(makeState());
    const res = await applyOperation(mockDeps({ executeCalls: execCalls }), {
      actorUserId: "u-actor",
      actorActorId: "a-actor",
      operation: { kind: "role.create", slug: "x", label: "X", capabilities: ["manage_server_security"] },
      fingerprint,
    });
    expect(res.applied).toBe(false);
    if (!res.applied) expect(res.code).toBe("authorization_denied");
    expect(execCalls.length).toBe(0);
  });

  test("applyDirectOperation skips fingerprint check (any fingerprint accepted)", async () => {
    const execCalls: AccessControlOperation[] = [];
    const res = await applyDirectOperation(mockDeps({ executeCalls: execCalls }), {
      actorUserId: "u-actor",
      actorActorId: "a-actor",
      operation: okOp,
    });
    expect(res.applied).toBe(true);
    expect(execCalls.length).toBe(1);
  });

  test("applyDirectOperation denied still rejects (no fingerprint bypass of policy)", async () => {
    const execCalls: AccessControlOperation[] = [];
    const res = await applyDirectOperation(mockDeps({ executeCalls: execCalls }), {
      actorUserId: "u-actor",
      actorActorId: "a-actor",
      operation: { kind: "role.delete", roleId: "r-admin" },
    });
    expect(res.applied).toBe(false);
    if (!res.applied) expect(res.code).toBe("authorization_denied");
    expect(execCalls.length).toBe(0);
  });

  test("audit payload carries the actor id and no secret material", async () => {
    const recorded: RbacAuditEventInput[] = [];
    const fingerprint = computeFingerprint(makeState());
    await applyOperation(mockDeps({ auditSink: (p) => recorded.push(p) }), {
      actorUserId: "u-actor",
      actorActorId: "a-actor",
      operation: okOp,
      fingerprint,
    });
    expect(recorded.length).toBe(1);
    expect(recorded[0]!.actorId).toBe("a-actor");
    const json = JSON.stringify(recorded[0]);
    expect(json).not.toContain("pin");
    expect(json).not.toContain("token");
    expect(json).not.toContain("secret");
  });

  test("audit payload for role.create is patched with the real created roleId", async () => {
    const recorded: RbacAuditEventInput[] = [];
    const fingerprint = computeFingerprint(makeState());
    const createOp: AccessControlOperation = {
      kind: "role.create",
      slug: `patched-${Date.now().toString(36)}`,
      label: "Patched",
      capabilities: ["use_terminal"],
    };
    await applyOperation(
      mockDeps({ auditSink: (p) => recorded.push(p), writeOutcome: { roleId: "r-real" } satisfies WriteOutcome }),
      { actorUserId: "u-actor", actorActorId: "a-actor", operation: createOp, fingerprint },
    );
    expect(recorded.length).toBe(1);
    expect((recorded[0] as { roleId: string }).roleId).toBe("r-real");
  });

  test("composite shared_access.create patches BOTH roleId and groupId into the audit payload", async () => {
    const recorded: RbacAuditEventInput[] = [];
    const fingerprint = computeFingerprint(makeState());
    const composite: AccessControlOperation = {
      kind: "shared_access.create",
      role: { slug: "qa", label: "QA", capabilities: ["use_terminal"] },
      group: { groupType: "custom:qa", label: "QA", ownerUserId: "u-owner" },
      memberUserIds: ["u-ada"],
    };
    await applyOperation(
      mockDeps({
        auditSink: (p) => recorded.push(p),
        writeOutcome: { roleId: "r-real", groupId: "g-real" } satisfies WriteOutcome,
      }),
      { actorUserId: "u-actor", actorActorId: "a-actor", operation: composite, fingerprint },
    );
    expect(recorded.length).toBe(1);
    const ev = recorded[0] as { kind: string; roleId: string; groupId: string };
    expect(ev.kind).toBe("rbac_shared_access_created");
    expect(ev.roleId).toBe("r-real");
    expect(ev.groupId).toBe("g-real");
    const json = JSON.stringify(recorded[0]);
    expect(json).not.toContain("pin");
    expect(json).not.toContain("token");
    expect(json).not.toContain("secret");
  });
});

// ---------------------------------------------------------------------------
// W3.2.13 — shared Permission-set / Group edits enumerate ALL affected
// Humans with true effective added/removed/unchanged deltas, de-duplicated.
// ---------------------------------------------------------------------------

describe("Stack 195 W3.2.13 — shared-edit affectedUserDeltas", () => {
  test("role.set_capabilities enumerates every affected Human across all carrying Groups, de-duped", () => {
    // r-mobile is carried by g-mobile (members u-ada, u-ben, u-fred). Change
    // its bundle from [use_terminal, control_browser] to [use_terminal,
    // use_high_impact_tools].
    //  - u-ada / u-ben are also Members, so use_high_impact_tools is already
    //    held via g-members → UNCHANGED (not added); control_browser removed.
    //  - u-fred is mobile-only, so use_high_impact_tools is genuinely ADDED.
    const res = evalOp({
      kind: "role.set_capabilities",
      roleId: "r-mobile",
      capabilities: ["use_terminal", "use_high_impact_tools"],
    });
    expect(res.ok).toBe(true);
    const deltas = res.affectedUserDeltas ?? [];
    const byId = new Map(deltas.map((d) => [d.userId, d]));
    // De-duped: one entry per Human, three Humans affected.
    expect(deltas.map((d) => d.userId).sort()).toEqual(["u-ada", "u-ben", "u-fred"]);
    const ada = byId.get("u-ada")!;
    expect(ada.added).toEqual([]); // use_high_impact_tools already held via g-members
    expect(ada.removed).toEqual(["control_browser"]);
    expect(ada.unchanged).toEqual(
      [...new Set([...MEMBER_BUNDLE, "use_terminal"])].sort(),
    );
    const fred = byId.get("u-fred")!;
    expect(fred.added).toEqual(["use_high_impact_tools"]);
    expect(fred.removed).toEqual(["control_browser"]);
    expect(fred.unchanged).toEqual(["use_terminal"]);
  });

  test("role.delete blast radius is truthful: removed caps only where not preserved elsewhere", () => {
    const res = evalOp({ kind: "role.delete", roleId: "r-mobile" });
    expect(res.ok).toBe(true);
    expect(res.deletionConsequence?.targetKind).toBe("role");
    const deltas = res.affectedUserDeltas ?? [];
    const ada = deltas.find((d) => d.userId === "u-ada")!;
    // r-mobile granted use_terminal + control_browser; both gone for u-ada,
    // but Member caps (use_workstation_profiles, use_high_impact_tools)
    // are preserved by g-members → UNCHANGED.
    expect(ada.removed).toEqual(["control_browser", "use_terminal"]);
    expect(ada.unchanged).toEqual([...MEMBER_BUNDLE].sort());
    expect(ada.added).toEqual([]);
  });

  test("group.set_roles produces truthful per-member affectedUserDeltas", () => {
    // Replace g-mobile's single role (mobile-dev: use_terminal, control_browser)
    // with power-dev (control_desktop, use_terminal). u-ada gains control_desktop,
    // keeps use_terminal (UNCHANGED), loses control_browser.
    const res = evalOp({
      kind: "group.set_roles",
      groupId: "g-mobile",
      roleSlugs: ["power-dev"],
    });
    expect(res.ok).toBe(true);
    const ada = (res.affectedUserDeltas ?? []).find((d) => d.userId === "u-ada")!;
    expect(ada.added).toEqual(["control_desktop"]);
    expect(ada.removed).toEqual(["control_browser"]);
    expect(ada.unchanged).toEqual(
      [...new Set([...MEMBER_BUNDLE, "use_terminal"])].sort(),
    );
  });

  test("group.delete affectedUserDeltas preserve caps held via other Groups", () => {
    const res = evalOp({ kind: "group.delete", groupId: "g-mobile" });
    expect(res.ok).toBe(true);
    const ada = (res.affectedUserDeltas ?? []).find((d) => d.userId === "u-ada")!;
    expect(ada.removed).toEqual(["control_browser", "use_terminal"]);
    expect(ada.unchanged).toEqual([...MEMBER_BUNDLE].sort());
  });
});

// ---------------------------------------------------------------------------
// W3.2.14 — atomic Create shared access composite.
// ---------------------------------------------------------------------------

const compositeOp = (overrides: Partial<{
  slug: string;
  groupType: string;
  ownerUserId: string;
  memberUserIds: readonly string[];
  capabilities: readonly string[];
}> = {}): AccessControlOperation => ({
  kind: "shared_access.create",
  role: {
    slug: overrides.slug ?? `qa-${Date.now().toString(36)}`,
    label: "QA",
    capabilities: overrides.capabilities ?? ["use_terminal"],
  },
  group: {
    groupType: overrides.groupType ?? "custom:qa",
    label: "QA",
    ownerUserId: overrides.ownerUserId ?? "u-owner",
  },
  memberUserIds: overrides.memberUserIds ?? ["u-ada"],
});

describe("Stack 195 W3.2.14 — shared_access.create composite", () => {
  test("authorized Owner creates shared access with true per-member effective deltas", () => {
    // New Permission set grants control_desktop — a cap neither initial
    // member holds today — so it is genuinely ADDED for each. use_terminal
    // (held via g-mobile) and the Member caps (held via g-members) are
    // UNCHANGED, not re-added.
    const res = evalOp(
      compositeOp({ capabilities: ["control_desktop"], memberUserIds: ["u-ada", "u-ada", "u-ben"] }),
    );
    expect(res.ok).toBe(true);
    expect(res.auditPreview.kind).toBe("rbac_shared_access_created");
    // De-duped member count in the audit preview.
    expect((res.auditPreview as { memberCount: number }).memberCount).toBe(2);
    const deltas = res.affectedUserDeltas ?? [];
    const byId = new Map(deltas.map((d) => [d.userId, d]));
    const expectedUnchanged = [...new Set([...MEMBER_BUNDLE, "use_terminal", "control_browser"])].sort();
    expect(byId.get("u-ada")!.added).toEqual(["control_desktop"]);
    expect(byId.get("u-ada")!.unchanged).toEqual(expectedUnchanged);
    expect(byId.get("u-ben")!.added).toEqual(["control_desktop"]);
    expect(byId.get("u-ben")!.unchanged).toEqual(expectedUnchanged);
    // No direct-user capability edges: the audit row carries only ids/slugs/counts.
    const json = JSON.stringify(res.auditPreview);
    expect(json).not.toContain("pin");
    expect(json).not.toContain("token");
    expect(json).not.toContain("secret");
  });

  test("missing any one of the three management caps rejects composite", () => {
    const res = evalOp(compositeOp(), {
      actorHoldsManagement: false,
      actorHeldManagementCaps: ["manage_roles", "manage_groups"],
    });
    expect(res.ok).toBe(false);
    expect(res.failures.map((f) => f.code)).toContain("missing_manage_members");
    expect(res.failures.map((f) => f.code)).not.toContain("missing_manage_roles");
  });

  test("nondelegable cap in the new Permission set rejects composite", () => {
    const res = evalOp(compositeOp({ capabilities: ["manage_server_security"] }));
    expect(res.ok).toBe(false);
    expect(res.failures.map((f) => f.code)).toContain("nondelegable_capability");
  });

  test("Admin-held uncontained-host policy in the new Permission set rejects composite", () => {
    const res = evalOp(
      compositeOp({ capabilities: ["manage_uncontained_host_commands"] }),
      { actorCaps: ADMIN_BUNDLE },
    );
    expect(res.ok).toBe(false);
    expect(res.failures.map((failure) => failure.code)).toContain("nondelegable_capability");
  });

  test("unknown capability rejects composite", () => {
    const res = evalOp(compositeOp({ capabilities: ["not_a_cap"] }));
    expect(res.ok).toBe(false);
    expect(res.failures.map((f) => f.code)).toContain("unknown_capability");
  });

  test("unheld capability rejects composite (insufficient_authority)", () => {
    const res = evalOp(
      compositeOp({ capabilities: ["control_desktop"] }),
      { actorCaps: ADMIN_MINUS_DESKTOP },
    );
    expect(res.ok).toBe(false);
    expect(res.failures.map((f) => f.code)).toContain("insufficient_authority");
  });

  test("reserved role slug rejects composite", () => {
    const res = evalOp(compositeOp({ slug: "admin" }));
    expect(res.ok).toBe(false);
    expect(res.failures.map((f) => f.code)).toContain("reserved_slug");
  });

  test("reserved / non-custom group type rejects composite", () => {
    const reserved = evalOp(compositeOp({ groupType: "members" }));
    expect(reserved.ok).toBe(false);
    expect(reserved.failures.map((f) => f.code)).toContain("reserved_type");
    const nonCustom = evalOp(compositeOp({ groupType: "qa" }));
    expect(nonCustom.ok).toBe(false);
    expect(nonCustom.failures.map((f) => f.code)).toContain("invalid_custom_type");
  });

  test("missing owner rejects composite", () => {
    const res = evalOp(compositeOp({ ownerUserId: "u-missing" }), { targetUserExists: false });
    expect(res.ok).toBe(false);
    expect(res.failures.map((f) => f.code)).toContain("user_not_found");
  });

  test("missing initial member rejects composite", () => {
    const res = evalOp(compositeOp({ memberUserIds: [] }));
    expect(res.ok).toBe(false);
  });

  test("already-used group type rejects composite", () => {
    const res = evalOp(compositeOp({ groupType: "custom:mobile" }));
    expect(res.ok).toBe(false);
    expect(res.failures.map((f) => f.code)).toContain("reserved_type");
  });

  test("composite happy path applies atomically (one execute, one audit event)", async () => {
    const execCalls: AccessControlOperation[] = [];
    const recorded: RbacAuditEventInput[] = [];
    const fingerprint = computeFingerprint(makeState());
    const res = await applyOperation(
      mockDeps({
        executeCalls: execCalls,
        auditSink: (p) => recorded.push(p),
        writeOutcome: { roleId: "r-real", groupId: "g-real" } satisfies WriteOutcome,
      }),
      {
        actorUserId: "u-actor",
        actorActorId: "a-actor",
        operation: compositeOp({ memberUserIds: ["u-ada", "u-ben"] }),
        fingerprint,
      },
    );
    expect(res.applied).toBe(true);
    // ONE execute call (the composite writes Role+Group+edge+members together).
    expect(execCalls.length).toBe(1);
    expect(execCalls[0]!.kind).toBe("shared_access.create");
    // ONE audit event.
    expect(recorded.length).toBe(1);
    expect(recorded[0]!.kind).toBe("rbac_shared_access_created");
  });

  test("composite validation failure leaves no partial rows (execute never called)", async () => {
    const execCalls: AccessControlOperation[] = [];
    const res = await applyOperation(
      mockDeps({ executeCalls: execCalls }),
      {
        actorUserId: "u-actor",
        actorActorId: "a-actor",
        operation: compositeOp({ capabilities: ["manage_server_security"] }),
        fingerprint: computeFingerprint(makeState()),
      },
    );
    expect(res.applied).toBe(false);
    if (!res.applied) expect(res.code).toBe("authorization_denied");
    expect(execCalls.length).toBe(0);
  });

  test("composite injected mid-write failure rolls back (execute throws → no audit)", async () => {
    const recorded: RbacAuditEventInput[] = [];
    const deps = mockDeps({ auditSink: (p) => recorded.push(p) });
    // Override execute to throw mid-write.
    deps.execute = async () => { throw new Error("mid-write boom"); };
    let threw = false;
    try {
      await applyOperation(deps, {
        actorUserId: "u-actor",
        actorActorId: "a-actor",
        operation: compositeOp(),
        fingerprint: computeFingerprint(makeState()),
      });
    } catch (err) {
      threw = true;
      expect(String(err)).toContain("mid-write boom");
    }
    expect(threw).toBe(true);
    // No audit event was written because the tx rolled back.
    expect(recorded.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// W3.2.14 — atomic Assign existing Permission set composite.
// ---------------------------------------------------------------------------

const assignExistingOp = (overrides: Partial<{
  roleSlug: string;
  groupType: string;
  ownerUserId: string;
  memberUserIds: readonly string[];
}> = {}): AccessControlOperation => ({
  kind: "shared_access.assign_existing",
  roleSlug: overrides.roleSlug ?? "mobile-dev",
  group: {
    groupType: overrides.groupType ?? "custom:qa",
    label: "QA",
    ownerUserId: overrides.ownerUserId ?? "u-owner",
  },
  memberUserIds: overrides.memberUserIds ?? ["u-ada"],
});

describe("Stack 195 W3.2.14 — shared_access.assign_existing composite", () => {
  test("authorized Owner assigns an existing custom Permission set with true per-member effective deltas", () => {
    // mobile-dev bundles use_terminal + control_browser. u-ada already holds
    // both via g-mobile, so the assign_existing delta is all-UNCHANGED for
    // u-ada; u-fred (mobile-only) also already holds both via g-mobile.
    // Use a custom cap to exercise a genuine ADDED: power-dev bundles
    // control_desktop which neither initial member holds.
    const res = evalOp(
      assignExistingOp({
        roleSlug: "power-dev",
        memberUserIds: ["u-ada", "u-ada", "u-ben"],
      }),
    );
    expect(res.ok).toBe(true);
    expect(res.auditPreview.kind).toBe("rbac_shared_access_assigned");
    // De-duped member count in the audit preview.
    expect((res.auditPreview as { memberCount: number }).memberCount).toBe(2);
    // The audit preview carries the EXISTING role's real id + slug + bundle.
    expect((res.auditPreview as { roleSlug: string }).roleSlug).toBe("power-dev");
    expect((res.auditPreview as { roleId: string }).roleId).toBe("r-power");
    expect((res.auditPreview as { capabilities: readonly string[] }).capabilities).toEqual(
      ["control_desktop", "use_terminal"],
    );
    const deltas = res.affectedUserDeltas ?? [];
    const byId = new Map(deltas.map((d) => [d.userId, d]));
    const adaExpectedUnchanged = [...new Set([...MEMBER_BUNDLE, "use_terminal", "control_browser"])].sort();
    // power-dev grants control_desktop (new for u-ada) + use_terminal (already held).
    expect(byId.get("u-ada")!.added).toEqual(["control_desktop"]);
    expect(byId.get("u-ada")!.unchanged).toEqual(adaExpectedUnchanged);
    expect(byId.get("u-ben")!.added).toEqual(["control_desktop"]);
    expect(byId.get("u-ben")!.unchanged).toEqual(adaExpectedUnchanged);
    // No direct-user capability edges: the audit row carries only ids/slugs/counts.
    const json = JSON.stringify(res.auditPreview);
    expect(json).not.toContain("pin");
    expect(json).not.toContain("token");
    expect(json).not.toContain("secret");
  });

  test("does NOT require manage_roles — missing manage_roles is not reported", () => {
    // Actor holds manage_groups + manage_members but NOT manage_roles.
    const res = evalOp(assignExistingOp(), {
      actorHoldsManagement: false,
      actorHeldManagementCaps: ["manage_groups", "manage_members"],
    });
    expect(res.ok).toBe(true);
    expect(res.failures.map((f) => f.code)).not.toContain("missing_manage_roles");
    expect(res.failures.map((f) => f.code)).not.toContain("missing_manage_groups");
    expect(res.failures.map((f) => f.code)).not.toContain("missing_manage_members");
  });

  test("missing manage_groups rejects composite", () => {
    const res = evalOp(assignExistingOp(), {
      actorHoldsManagement: false,
      actorHeldManagementCaps: ["manage_members"],
    });
    expect(res.ok).toBe(false);
    expect(res.failures.map((f) => f.code)).toContain("missing_manage_groups");
  });

  test("missing manage_members rejects composite", () => {
    const res = evalOp(assignExistingOp(), {
      actorHoldsManagement: false,
      actorHeldManagementCaps: ["manage_groups"],
    });
    expect(res.ok).toBe(false);
    expect(res.failures.map((f) => f.code)).toContain("missing_manage_members");
  });

  test("canonical/system role rejected (protected_definition)", () => {
    const res = evalOp(assignExistingOp({ roleSlug: "admin" }));
    expect(res.ok).toBe(false);
    expect(res.failures.map((f) => f.code)).toContain("protected_definition");
  });

  test("unknown role slug rejected (not_found)", () => {
    const res = evalOp(assignExistingOp({ roleSlug: "no-such-role" }));
    expect(res.ok).toBe(false);
    expect(res.failures.map((f) => f.code)).toContain("not_found");
  });

  test("stronger/unheld bundle rejected (insufficient_authority)", () => {
    // power-dev bundles control_desktop which the actor lacks.
    const res = evalOp(
      assignExistingOp({ roleSlug: "power-dev" }),
      { actorCaps: ADMIN_MINUS_DESKTOP },
    );
    expect(res.ok).toBe(false);
    expect(res.failures.map((f) => f.code)).toContain("insufficient_authority");
  });

  test("reserved / non-custom / duplicate group type rejected", () => {
    const reserved = evalOp(assignExistingOp({ groupType: "members" }));
    expect(reserved.ok).toBe(false);
    expect(reserved.failures.map((f) => f.code)).toContain("reserved_type");
    const nonCustom = evalOp(assignExistingOp({ groupType: "qa" }));
    expect(nonCustom.ok).toBe(false);
    expect(nonCustom.failures.map((f) => f.code)).toContain("invalid_custom_type");
    const dup = evalOp(assignExistingOp({ groupType: "custom:mobile" }));
    expect(dup.ok).toBe(false);
    expect(dup.failures.map((f) => f.code)).toContain("reserved_type");
  });

  test("missing owner rejects composite", () => {
    const res = evalOp(assignExistingOp({ ownerUserId: "u-missing" }), { targetUserExists: false });
    expect(res.ok).toBe(false);
    expect(res.failures.map((f) => f.code)).toContain("user_not_found");
  });

  test("missing initial member rejects composite", () => {
    const res = evalOp(assignExistingOp({ memberUserIds: [] }));
    expect(res.ok).toBe(false);
  });

  test("assign_existing happy path applies atomically (one execute, one audit event)", async () => {
    const execCalls: AccessControlOperation[] = [];
    const recorded: RbacAuditEventInput[] = [];
    const fingerprint = computeFingerprint(makeState());
    const res = await applyOperation(
      mockDeps({
        executeCalls: execCalls,
        auditSink: (p) => recorded.push(p),
        writeOutcome: { roleId: "r-mobile", groupId: "g-real" } satisfies WriteOutcome,
      }),
      {
        actorUserId: "u-actor",
        actorActorId: "a-actor",
        operation: assignExistingOp({ memberUserIds: ["u-ada", "u-ben"] }),
        fingerprint,
      },
    );
    expect(res.applied).toBe(true);
    // ONE execute call (the composite writes Group+edge+members together).
    expect(execCalls.length).toBe(1);
    expect(execCalls[0]!.kind).toBe("shared_access.assign_existing");
    // ONE audit event.
    expect(recorded.length).toBe(1);
    expect(recorded[0]!.kind).toBe("rbac_shared_access_assigned");
  });

  test("assign_existing patches BOTH roleId and groupId into the audit payload", async () => {
    const recorded: RbacAuditEventInput[] = [];
    const fingerprint = computeFingerprint(makeState());
    await applyOperation(
      mockDeps({
        auditSink: (p) => recorded.push(p),
        writeOutcome: { roleId: "r-mobile", groupId: "g-real" } satisfies WriteOutcome,
      }),
      {
        actorUserId: "u-actor",
        actorActorId: "a-actor",
        operation: assignExistingOp(),
        fingerprint,
      },
    );
    expect(recorded.length).toBe(1);
    const ev = recorded[0] as { kind: string; roleId: string; groupId: string };
    expect(ev.kind).toBe("rbac_shared_access_assigned");
    expect(ev.roleId).toBe("r-mobile");
    expect(ev.groupId).toBe("g-real");
  });

  test("assign_existing validation failure leaves no partial rows (execute never called)", async () => {
    const execCalls: AccessControlOperation[] = [];
    const res = await applyOperation(
      mockDeps({ executeCalls: execCalls }),
      {
        actorUserId: "u-actor",
        actorActorId: "a-actor",
        // Canonical role → protected_definition failure.
        operation: assignExistingOp({ roleSlug: "admin" }),
        fingerprint: computeFingerprint(makeState()),
      },
    );
    expect(res.applied).toBe(false);
    if (!res.applied) expect(res.code).toBe("authorization_denied");
    expect(execCalls.length).toBe(0);
  });

  test("assign_existing injected mid-write failure rolls back (execute throws → no audit)", async () => {
    const recorded: RbacAuditEventInput[] = [];
    const deps = mockDeps({ auditSink: (p) => recorded.push(p) });
    deps.execute = async () => { throw new Error("mid-write boom"); };
    let threw = false;
    try {
      await applyOperation(deps, {
        actorUserId: "u-actor",
        actorActorId: "a-actor",
        operation: assignExistingOp(),
        fingerprint: computeFingerprint(makeState()),
      });
    } catch (err) {
      threw = true;
      expect(String(err)).toContain("mid-write boom");
    }
    expect(threw).toBe(true);
    expect(recorded.length).toBe(0);
  });

  test("assign_existing stale fingerprint → stale_preview, no execute", async () => {
    const execCalls: AccessControlOperation[] = [];
    const res = await applyOperation(mockDeps({ executeCalls: execCalls }), {
      actorUserId: "u-actor",
      actorActorId: "a-actor",
      operation: assignExistingOp(),
      fingerprint: "v1:WRONG",
    });
    expect(res.applied).toBe(false);
    if (!res.applied) expect(res.code).toBe("stale_preview");
    expect(execCalls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Stack 195 follow-up — Owner invariant + bypassedRail audit precision.
// The sole-Owner rail lives in `executeOperationWrites` (covered by the
// integration suite against a real DB); the audit-preview precision is a
// pure decision-core concern, so it is covered here.
// ---------------------------------------------------------------------------

describe("Stack 195 follow-up — membership.remove audit precision (bypassedRail)", () => {
  test("bypassedRail is false for a normal successful removal (no bypass requested)", () => {
    const res = evalOp({ kind: "membership.remove", groupId: "g-mobile", userId: "u-ada" });
    expect(res.ok).toBe(true);
    expect(res.auditPreview.kind).toBe("group_member_removed");
    expect((res.auditPreview as { bypassedRail?: boolean }).bypassedRail).toBe(false);
  });

  test("bypassedRail is false even when bypassLastOwner=true is requested", () => {
    // The compatibility flag is kept on the operation shape so legacy
    // callers still typecheck, but the last-Owner rail is no longer
    // bypassable. A successful removal NEVER logs a bypass — the rail was
    // not exercised. Requesting a bypass must not produce a bypass audit.
    const res = evalOp({
      kind: "membership.remove",
      groupId: "g-mobile",
      userId: "u-ada",
      bypassLastOwner: true,
    });
    expect(res.ok).toBe(true);
    expect(res.auditPreview.kind).toBe("group_member_removed");
    expect((res.auditPreview as { bypassedRail?: boolean }).bypassedRail).toBe(false);
  });

  test("bypassedRail is false for a multi-Owner removal (rail not exercised)", () => {
    // g-owners has two members (u-owner, u-owner2); removing one of several
    // Owners does not trip the sole-Owner rail, so bypassedRail is false.
    const res = evalOp({
      kind: "membership.remove",
      groupId: "g-owners",
      userId: "u-owner2",
    });
    expect(res.ok).toBe(true);
    expect((res.auditPreview as { bypassedRail?: boolean }).bypassedRail).toBe(false);
  });

  test("audit preview for membership.remove never carries secret material", () => {
    const res = evalOp({
      kind: "membership.remove",
      groupId: "g-mobile",
      userId: "u-ada",
      bypassLastOwner: true,
    });
    const json = JSON.stringify(res.auditPreview);
    expect(json).not.toContain("pin");
    expect(json).not.toContain("token");
    expect(json).not.toContain("secret");
  });
});

// ---------------------------------------------------------------------------
// Stack 195 follow-up — sole-Owner removal preview/apply parity. The preview
// must surface a stable `last_owner` check (so the UI can show "this would
// leave zero Owners" before the user hits Apply), and apply must map the
// same invariant to the stable 409 `last_owner` the direct + legacy routes
// already return — without ever running execute for a rejected preview.
// ---------------------------------------------------------------------------

function soleOwnerState(): EngineState {
  return makeState({
    groups: makeState().groups.map((g) =>
      g.id === "g-owners" ? { ...g, members: ["u-owner"], memberCount: 1 } : g,
    ),
  });
}

describe("Stack 195 follow-up — sole-Owner removal preview/apply parity", () => {
  test("preview rejects removing the sole Owner with a stable last_owner check (bypass=false)", () => {
    const res = evalOp(
      { kind: "membership.remove", groupId: "g-owners", userId: "u-owner" },
      { state: soleOwnerState() },
    );
    expect(res.ok).toBe(false);
    expect(failureCodes(res)).toContain("last_owner");
    const lastOwner = res.failures.find((f) => f.code === "last_owner")!;
    expect(lastOwner.detail).toBe("removing the sole Owner would leave zero Owners");
  });

  test("preview rejects removing the sole Owner REGARDLESS of bypassLastOwner (bypass=true)", () => {
    // The bypass flag is kept on the operation shape for legacy callers but
    // is no longer honored for the sole-Owner case — the rail fires either way.
    const res = evalOp(
      { kind: "membership.remove", groupId: "g-owners", userId: "u-owner", bypassLastOwner: true },
      { state: soleOwnerState() },
    );
    expect(res.ok).toBe(false);
    expect(failureCodes(res)).toContain("last_owner");
  });

  test("preview allows removing one of several Owners (multi-Owner; no last_owner failure)", () => {
    // Default state has g-owners with two members (u-owner, u-owner2); removing
    // one of several Owners does NOT trip the sole-Owner rail.
    const res = evalOp({ kind: "membership.remove", groupId: "g-owners", userId: "u-owner2" });
    expect(res.ok).toBe(true);
    expect(failureCodes(res)).not.toContain("last_owner");
  });

  test("preview last_owner rail keys off the fingerprinted members edge (a non-member removal does not trip it)", () => {
    // Sole Owner is u-owner; attempting to remove a DIFFERENT user (who is not
    // the sole member) must NOT trip last_owner — the rail only fires when the
    // exact sole member is the removal target.
    const res = evalOp(
      { kind: "membership.remove", groupId: "g-owners", userId: "u-other" },
      { state: soleOwnerState() },
    );
    expect(failureCodes(res)).not.toContain("last_owner");
  });

  test("authority takes precedence over last_owner: an unauthorized actor removing the sole Owner is rejected with insufficient_authority (403), not last_owner (409)", () => {
    // An Admin (lacks the Owner-only nondelegable caps) attempting to remove
    // the sole Owner must be rejected for authority, NOT trip the last-Owner
    // rail — otherwise the stable 403 authorization_denied mapping the
    // direct/legacy routes return for an unauthorized removal would regress
    // to 409 last_owner.
    const res = evalOp(
      { kind: "membership.remove", groupId: "g-owners", userId: "u-owner" },
      { state: soleOwnerState(), actorCaps: ADMIN_BUNDLE },
    );
    expect(res.ok).toBe(false);
    expect(failureCodes(res)).toContain("insufficient_authority");
    expect(failureCodes(res)).not.toContain("last_owner");
  });

  test("applyOperation sole-Owner removal throws MembershipOpError(last_owner) and never executes", async () => {
    const state = soleOwnerState();
    const execCalls: AccessControlOperation[] = [];
    const fingerprint = computeFingerprint(state);
    let err: unknown;
    try {
      await applyOperation(mockDeps({ state, executeCalls: execCalls }), {
        actorUserId: "u-actor",
        actorActorId: "a-actor",
        operation: { kind: "membership.remove", groupId: "g-owners", userId: "u-owner" },
        fingerprint,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MembershipOpError);
    expect((err as MembershipOpError).opCode).toBe("last_owner");
    // A rejected preview MUST NOT reach execute.
    expect(execCalls.length).toBe(0);
  });

  test("applyDirectOperation sole-Owner removal throws MembershipOpError(last_owner) (legacy/direct path parity)", async () => {
    const state = soleOwnerState();
    const execCalls: AccessControlOperation[] = [];
    let err: unknown;
    try {
      await applyDirectOperation(mockDeps({ state, executeCalls: execCalls }), {
        actorUserId: "u-actor",
        actorActorId: "a-actor",
        operation: { kind: "membership.remove", groupId: "g-owners", userId: "u-owner", bypassLastOwner: true },
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MembershipOpError);
    expect((err as MembershipOpError).opCode).toBe("last_owner");
    expect(execCalls.length).toBe(0);
  });
});

// Keep the ApplyResult type referenced for the type-only import.
void (null as unknown as ApplyResult);
