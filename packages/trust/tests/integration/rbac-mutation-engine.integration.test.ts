/**
 * Stack 195 / W3.2 — integration coverage for the production preview/apply
 * wiring of the RBAC mutation engine against the real DB. Verifies
 * preview/apply parity, stale-preview rejection, and the audit append
 * result shape. The pure policy matrix is covered in
 * `tests/unit/rbac-mutation-engine.test.ts`; the route + real audit-file
 * writer is covered in the server integration suite.
 */
import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../.env") });

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  actors,
  agents,
  capabilities,
  channelIdentities,
  createDirectDb,
  eq,
  groupMembers,
  groupRoles,
  groups,
  inArray,
  profiles,
  roleCapabilities,
  roles,
  users,
} from "@nautilo/db";
import { ensureDatabase } from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import {
  applyOperation,
  createProductionMutationEngineDeps,
  previewOperation,
  type RbacAuditEventInput,
} from "../../src/rbac-mutation-engine";
import { MembershipOpError } from "../../src/queries";

let db: ReturnType<typeof createDirectDb>;
let ownerUserId: string;
let ownerActorId: string;
let ownerAgentId: string;
let memberUserId: string;
const ts = Date.now().toString(36);
const createdRoleIds: string[] = [];
const createdGroupIds: string[] = [];
const createdUserIds: string[] = [];
const recordedAudit: RbacAuditEventInput[] = [];

function deps(auditSink: (payload: RbacAuditEventInput) => void = (p) => recordedAudit.push(p)) {
  return createProductionMutationEngineDeps({
    actorActorId: ownerActorId,
    appendAuditEvent: auditSink,
  });
}

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(1);

  const handle = `s195w32${ts.slice(-6)}`;
  const [user] = await db
    .insert(users)
    .values({
      name: "s195w32-owner",
      email: `s195w32-${ts}@test.local`,
      handle,
      externalId: `s195w32-${ts}`,
    })
    .returning({ id: users.id });
  if (!user) throw new Error("owner insert failed");
  ownerUserId = user.id;

  const [actor] = await db
    .insert(actors)
    .values({ ownerId: ownerUserId, displayName: "s195w32 Owner", kind: "user", trustState: "verified" })
    .returning({ id: actors.id });
  if (!actor) throw new Error("owner actor insert failed");
  ownerActorId = actor.id;

  const [ag] = await db
    .insert(agents)
    .values({ handle: `ag-${handle}` })
    .returning({ id: agents.id });
  if (!ag) throw new Error("owner agent insert failed");
  ownerAgentId = ag.id;
  await db.insert(actors).values({
    ownerId: ownerUserId,
    displayName: "s195w32 owner agent actor",
    kind: "agent",
    agentId: ag.id,
    trustState: "verified",
  });
  await db.insert(profiles).values({ userId: ownerUserId, agentId: ag.id, name: "s195w32" });

  // Defensively seed the canonical `admins` ladder rung (capabilities + the
  // `admin` Role + its bundle + the `admins` Group) so the suite runs on an
  // instance whose `seedTrustPersonal` has not been executed. All inserts are
  // idempotent (ON CONFLICT DO NOTHING). The Admin Role bundles every
  // delegable cap (everything except the two Owner-only nondelegable caps),
  // so a test user seated in `admins` can administer custom Roles/Groups.
  const capSeeds = [
    { slug: "use_terminal", description: "Terminal", category: "devices" },
    { slug: "control_browser", description: "Browser", category: "devices" },
    { slug: "control_desktop", description: "Desktop", category: "devices" },
    { slug: "use_workstation_profiles", description: "Activate a profile", category: "devices" },
    { slug: "use_high_impact_tools", description: "High impact tools", category: "tools" },
    { slug: "manage_members", description: "Manage members", category: "administration" },
    { slug: "manage_groups", description: "Manage groups", category: "administration" },
    { slug: "manage_roles", description: "Manage roles", category: "administration" },
    { slug: "manage_agents", description: "Manage agents", category: "administration" },
    { slug: "view_audit_log", description: "View audit log", category: "administration" },
    { slug: "manage_workstation_profiles", description: "Manage workstation profiles", category: "administration" },
    { slug: "manage_server_settings", description: "Manage server settings", category: "administration" },
    { slug: "manage_server_security", description: "Manage server security", category: "administration" },
  ];
  await db.insert(capabilities).values(capSeeds).onConflictDoNothing({ target: capabilities.slug });
  const allCaps = await db.select().from(capabilities);
  const capId = (slug: string) => allCaps.find((c) => c.slug === slug)?.id;

  await db
    .insert(roles)
    .values({ slug: "admin", label: "Admin", isSystem: true })
    .onConflictDoNothing({ target: roles.slug });
  const [adminRole] = await db.select({ id: roles.id }).from(roles).where(eq(roles.slug, "admin")).limit(1);
  if (!adminRole) throw new Error("admin role seed failed");
  const adminBundle = capSeeds
    .map((c) => c.slug)
    .filter((s) => s !== "manage_server_settings" && s !== "manage_server_security");
  await db
    .insert(roleCapabilities)
    .values(adminBundle.map((slug) => ({ roleId: adminRole.id, capabilityId: capId(slug)! })))
    .onConflictDoNothing();

  await db
    .insert(groups)
    .values({ type: "admins", label: "Admins", isSystem: true, trustPreset: "personal" })
    .onConflictDoNothing({ target: groups.type });
  const [adminsGroup] = await db.select({ id: groups.id }).from(groups).where(eq(groups.type, "admins")).limit(1);
  if (!adminsGroup) throw new Error("admins group seed failed");
  await db
    .insert(groupRoles)
    .values({ groupId: adminsGroup.id, roleId: adminRole.id })
    .onConflictDoNothing();
  await db
    .insert(groupMembers)
    .values({ groupId: adminsGroup.id, userId: ownerUserId, grantedBy: ownerActorId })
    .onConflictDoNothing({ target: [groupMembers.groupId, groupMembers.userId] });

  // A second Human used as an initial member / shared-edit subject. Seated
  // in `members` so source-aware UNCHANGED deltas can be exercised (a cap
  // preserved by `members` stays UNCHANGED when a custom Group membership
  // is removed).
  const [member] = await db
    .insert(users)
    .values({
      name: "s195w32-member",
      email: `s195w32-m-${ts}@test.local`,
      handle: `s195w32m${ts.slice(-6)}`,
      externalId: `s195w32-m-${ts}`,
    })
    .returning({ id: users.id });
  if (!member) throw new Error("member insert failed");
  memberUserId = member.id;
  createdUserIds.push(memberUserId);
  const [membersGroup] = await db.select({ id: groups.id }).from(groups).where(eq(groups.type, "members")).limit(1);
  if (membersGroup) {
    await db
      .insert(groupMembers)
      .values({ groupId: membersGroup.id, userId: memberUserId, grantedBy: ownerActorId })
      .onConflictDoNothing({ target: [groupMembers.groupId, groupMembers.userId] });
  }
});

afterAll(async () => {
  if (!db) return;
  try {
    for (const uid of createdUserIds) {
      await db.delete(groupMembers).where(eq(groupMembers.userId, uid));
    }
    await db.delete(groupMembers).where(eq(groupMembers.userId, ownerUserId));
    if (createdGroupIds.length > 0) await db.delete(groups).where(inArray(groups.id, createdGroupIds));
    if (createdRoleIds.length > 0) await db.delete(roles).where(inArray(roles.id, createdRoleIds));
    for (const uid of createdUserIds) {
      await db.delete(profiles).where(eq(profiles.userId, uid));
      await db.delete(channelIdentities).where(eq(channelIdentities.userId, uid));
      await db.delete(actors).where(eq(actors.ownerId, uid));
      await db.delete(users).where(eq(users.id, uid));
    }
    await db.delete(profiles).where(eq(profiles.userId, ownerUserId));
    await db.delete(channelIdentities).where(eq(channelIdentities.userId, ownerUserId));
    await db.delete(actors).where(eq(actors.ownerId, ownerUserId));
    await db.delete(agents).where(eq(agents.id, ownerAgentId));
    await db.delete(users).where(eq(users.id, ownerUserId));
  } finally {
    await db.end();
  }
});

describe("Stack 195 W3.2 — preview/apply engine (real DB)", () => {
  test("preview then apply creates a custom role (parity)", async () => {
    const slug = `qa-role-${ts}`;
    const preview = await previewOperation(deps(), {
      actorUserId: ownerUserId,
      actorActorId: ownerActorId,
      operation: { kind: "role.create", slug, label: "QA", capabilities: ["use_terminal"] },
    });
    expect(preview.ok).toBe(true);
    expect(preview.auditPreview.kind).toBe("rbac_role_created");
    expect(preview.fingerprint.length).toBeGreaterThan(0);

    const apply = await applyOperation(deps(), {
      actorUserId: ownerUserId,
      actorActorId: ownerActorId,
      operation: { kind: "role.create", slug, label: "QA", capabilities: ["use_terminal"] },
      fingerprint: preview.fingerprint,
    });
    expect(apply.applied).toBe(true);
    if (apply.applied) {
      expect(apply.auditRecorded).toBe(true);
      expect(apply.fingerprint).toBe(preview.fingerprint);
    }
    const [row] = await db.select({ id: roles.id }).from(roles).where(eq(roles.slug, slug)).limit(1);
    expect(row).toBeDefined();
    if (row) createdRoleIds.push(row.id);
    expect(recordedAudit.some((e) => e.kind === "rbac_role_created")).toBe(true);
  });

  test("stale preview is rejected with 409 stale_preview", async () => {
    const slug = `stale-${ts}`;
    const preview = await previewOperation(deps(), {
      actorUserId: ownerUserId,
      actorActorId: ownerActorId,
      operation: { kind: "role.create", slug, label: "Stale", capabilities: [] },
    });
    expect(preview.ok).toBe(true);
    // Drift the state between preview and apply by inserting another role.
    const [drift] = await db
      .insert(roles)
      .values({ slug: `drift-${ts}`, label: "Drift", isSystem: false })
      .returning({ id: roles.id });
    if (drift) createdRoleIds.push(drift.id);
    const apply = await applyOperation(deps(), {
      actorUserId: ownerUserId,
      actorActorId: ownerActorId,
      operation: { kind: "role.create", slug, label: "Stale", capabilities: [] },
      fingerprint: preview.fingerprint,
    });
    expect(apply.applied).toBe(false);
    if (!apply.applied) expect(apply.code).toBe("stale_preview");
    // The stale role was NOT created.
    const [row] = await db.select({ id: roles.id }).from(roles).where(eq(roles.slug, slug)).limit(1);
    expect(row).toBeUndefined();
  });

  test("apply with a failing audit writer returns applied:true, auditRecorded:false", async () => {
    const slug = `noaudit-${ts}`;
    const preview = await previewOperation(deps(() => { throw new Error("disk full"); }), {
      actorUserId: ownerUserId,
      actorActorId: ownerActorId,
      operation: { kind: "role.create", slug, label: "NoAudit", capabilities: [] },
    });
    expect(preview.ok).toBe(true);
    const apply = await applyOperation(deps(() => { throw new Error("disk full"); }), {
      actorUserId: ownerUserId,
      actorActorId: ownerActorId,
      operation: { kind: "role.create", slug, label: "NoAudit", capabilities: [] },
      fingerprint: preview.fingerprint,
    });
    expect(apply.applied).toBe(true);
    if (apply.applied) expect(apply.auditRecorded).toBe(false);
    const [row] = await db.select({ id: roles.id }).from(roles).where(eq(roles.slug, slug)).limit(1);
    if (row) createdRoleIds.push(row.id);
    expect(row).toBeDefined();
  });

  test("custom group create + set_roles through the engine", async () => {
    const roleSlug = `grp-role-${ts}`;
    const groupType = `custom:grp-${ts}`;
    const rp = await previewOperation(deps(), {
      actorUserId: ownerUserId,
      actorActorId: ownerActorId,
      operation: { kind: "role.create", slug: roleSlug, label: "GR", capabilities: ["control_browser"] },
    });
    expect(rp.ok).toBe(true);
    const ra = await applyOperation(deps(), {
      actorUserId: ownerUserId,
      actorActorId: ownerActorId,
      operation: { kind: "role.create", slug: roleSlug, label: "GR", capabilities: ["control_browser"] },
      fingerprint: rp.fingerprint,
    });
    expect(ra.applied).toBe(true);
    const [roleRow] = await db.select({ id: roles.id }).from(roles).where(eq(roles.slug, roleSlug)).limit(1);
    if (roleRow) createdRoleIds.push(roleRow.id);
    expect(roleRow).toBeDefined();

    const gp = await previewOperation(deps(), {
      actorUserId: ownerUserId,
      actorActorId: ownerActorId,
      operation: { kind: "group.create", groupType, label: "GRP", ownerUserId: ownerUserId, roleSlugs: [roleSlug] },
    });
    expect(gp.ok).toBe(true);
    const ga = await applyOperation(deps(), {
      actorUserId: ownerUserId,
      actorActorId: ownerActorId,
      operation: { kind: "group.create", groupType, label: "GRP", ownerUserId: ownerUserId, roleSlugs: [roleSlug] },
      fingerprint: gp.fingerprint,
    });
    expect(ga.applied).toBe(true);
    const [groupRow] = await db.select({ id: groups.id }).from(groups).where(eq(groups.type, groupType)).limit(1);
    if (groupRow) createdGroupIds.push(groupRow.id);
    expect(groupRow).toBeDefined();
    const edges = await db.select().from(groupRoles).where(eq(groupRoles.groupId, groupRow!.id));
    expect(edges.length).toBe(1);
  });

  test("protected system role delete is rejected in preview", async () => {
    const [adminRole] = await db.select({ id: roles.id }).from(roles).where(eq(roles.slug, "admin")).limit(1);
    expect(adminRole).toBeDefined();
    const preview = await previewOperation(deps(), {
      actorUserId: ownerUserId,
      actorActorId: ownerActorId,
      operation: { kind: "role.delete", roleId: adminRole!.id },
    });
    expect(preview.ok).toBe(false);
    expect(preview.failures.map((f) => f.code)).toContain("protected_definition");
  });

  test("reserved slug rejected in preview", async () => {
    const preview = await previewOperation(deps(), {
      actorUserId: ownerUserId,
      actorActorId: ownerActorId,
      operation: { kind: "role.create", slug: "member", label: "M", capabilities: [] },
    });
    expect(preview.ok).toBe(false);
    expect(preview.failures.map((f) => f.code)).toContain("reserved_slug");
  });

  test("group delete removes approval_challenges safely (real DB)", async () => {
    // Create a custom group, then attach an approval_challenge row to it,
    // then delete the group through the engine and confirm the challenge
    // row is gone (no FK NO ACTION surprise).
    const groupType = `custom:del-${ts}`;
    const gp = await previewOperation(deps(), {
      actorUserId: ownerUserId,
      actorActorId: ownerActorId,
      operation: { kind: "group.create", groupType, label: "Del", ownerUserId: ownerUserId, roleSlugs: [] },
    });
    expect(gp.ok).toBe(true);
    const ga = await applyOperation(deps(), {
      actorUserId: ownerUserId,
      actorActorId: ownerActorId,
      operation: { kind: "group.create", groupType, label: "Del", ownerUserId: ownerUserId, roleSlugs: [] },
      fingerprint: gp.fingerprint,
    });
    expect(ga.applied).toBe(true);
    const [groupRow] = await db.select({ id: groups.id }).from(groups).where(eq(groups.type, groupType)).limit(1);
    if (!groupRow) throw new Error("del group not created");
    createdGroupIds.push(groupRow.id);

    const { approvalChallenges } = await import("@nautilo/db");
    const [challenge] = await db
      .insert(approvalChallenges)
      .values({
        groupId: groupRow.id,
        requiredCapability: "use_terminal",
        requestedBy: ownerUserId,
        action: "test",
        eligibleApprovers: [],
        expiresAt: new Date(Date.now() + 60_000),
      })
      .returning({ id: approvalChallenges.id });
    expect(challenge).toBeDefined();

    const dp = await previewOperation(deps(), {
      actorUserId: ownerUserId,
      actorActorId: ownerActorId,
      operation: { kind: "group.delete", groupId: groupRow.id },
    });
    expect(dp.ok).toBe(true);
    expect(dp.deletionConsequence?.approvalChallengesRemoved).toBe(1);
    const da = await applyOperation(deps(), {
      actorUserId: ownerUserId,
      actorActorId: ownerActorId,
      operation: { kind: "group.delete", groupId: groupRow.id },
      fingerprint: dp.fingerprint,
    });
    expect(da.applied).toBe(true);
    const [gone] = await db.select({ id: approvalChallenges.id }).from(approvalChallenges).where(eq(approvalChallenges.id, challenge!.id)).limit(1);
    expect(gone).toBeUndefined();
    // remove from cleanup set (already deleted)
    const idx = createdGroupIds.indexOf(groupRow.id);
    if (idx >= 0) createdGroupIds.splice(idx, 1);
  });

  test("W3.2.13 membership removal where another Group preserves a cap => UNCHANGED, not removed", async () => {
    // Create a custom Role + Group granting use_terminal + control_browser,
    // seat the member in it AND in the canonical `members` Group (which
    // grants use_workstation_profiles + use_high_impact_tools). Removing
    // the member from the custom Group must drop only the custom caps; the
    // Member caps are preserved by `members` → UNCHANGED.
    const roleSlug = `src-role-${ts}`;
    const groupType = `custom:src-${ts}`;
    const rp = await previewOperation(deps(), {
      actorUserId: ownerUserId,
      actorActorId: ownerActorId,
      operation: { kind: "role.create", slug: roleSlug, label: "SRC", capabilities: ["use_terminal", "control_browser"] },
    });
    expect(rp.ok).toBe(true);
    const ra = await applyOperation(deps(), {
      actorUserId: ownerUserId,
      actorActorId: ownerActorId,
      operation: { kind: "role.create", slug: roleSlug, label: "SRC", capabilities: ["use_terminal", "control_browser"] },
      fingerprint: rp.fingerprint,
    });
    expect(ra.applied).toBe(true);
    const [roleRow] = await db.select({ id: roles.id }).from(roles).where(eq(roles.slug, roleSlug)).limit(1);
    if (roleRow) createdRoleIds.push(roleRow.id);
    expect(roleRow).toBeDefined();

    const gp = await previewOperation(deps(), {
      actorUserId: ownerUserId,
      actorActorId: ownerActorId,
      operation: { kind: "group.create", groupType, label: "SRCG", ownerUserId: ownerUserId, roleSlugs: [roleSlug] },
    });
    expect(gp.ok).toBe(true);
    const ga = await applyOperation(deps(), {
      actorUserId: ownerUserId,
      actorActorId: ownerActorId,
      operation: { kind: "group.create", groupType, label: "SRCG", ownerUserId: ownerUserId, roleSlugs: [roleSlug] },
      fingerprint: gp.fingerprint,
    });
    expect(ga.applied).toBe(true);
    const [groupRow] = await db.select({ id: groups.id }).from(groups).where(eq(groups.type, groupType)).limit(1);
    if (groupRow) createdGroupIds.push(groupRow.id);
    expect(groupRow).toBeDefined();

    // Seat the member in the custom Group.
    const ap = await previewOperation(deps(), {
      actorUserId: ownerUserId,
      actorActorId: ownerActorId,
      operation: { kind: "membership.add", groupId: groupRow!.id, userId: memberUserId },
    });
    expect(ap.ok).toBe(true);
    const aa = await applyOperation(deps(), {
      actorUserId: ownerUserId,
      actorActorId: ownerActorId,
      operation: { kind: "membership.add", groupId: groupRow!.id, userId: memberUserId },
      fingerprint: ap.fingerprint,
    });
    expect(aa.applied).toBe(true);

    // Preview the removal: the member's true effective delta must list the
    // custom caps as REMOVED and the Member caps as UNCHANGED.
    const rp2 = await previewOperation(deps(), {
      actorUserId: ownerUserId,
      actorActorId: ownerActorId,
      operation: { kind: "membership.remove", groupId: groupRow!.id, userId: memberUserId },
    });
    expect(rp2.ok).toBe(true);
    expect(rp2.affectedUserDelta?.userId).toBe(memberUserId);
    // The custom caps are genuinely removed (no other source grants them).
    expect(rp2.affectedUserDelta?.removed).toEqual(["control_browser", "use_terminal"]);
    expect(rp2.affectedUserDelta?.added).toEqual([]);
    // The Member-bundle caps are preserved by the canonical `members` Group →
    // UNCHANGED. Assert the property robustly against the real (large) Member
    // bundle rather than hardcoding it: the two custom caps must NOT appear
    // in unchanged, and a known Member cap must.
    const unchanged = rp2.affectedUserDelta?.unchanged ?? [];
    expect(unchanged).toContain("use_workstation_profiles");
    expect(unchanged).not.toContain("control_browser");
    expect(unchanged).not.toContain("use_terminal");
    // Clean up this test's custom Group + Role now so it cannot pollute the
    // later shared-edit / composite tests (which create their own groups and
    // rely on the member NOT also holding these caps via a leftover group).
    await db.delete(groupMembers).where(eq(groupMembers.groupId, groupRow!.id));
    await db.delete(groups).where(eq(groups.id, groupRow!.id));
    await db.delete(roles).where(eq(roles.id, roleRow!.id));
    const gidx = createdGroupIds.indexOf(groupRow!.id);
    if (gidx >= 0) createdGroupIds.splice(gidx, 1);
    const ridx = createdRoleIds.indexOf(roleRow!.id);
    if (ridx >= 0) createdRoleIds.splice(ridx, 1);
  });

  test("W3.2.13 shared Permission-set edit enumerates affected Humans with true deltas", async () => {
    // Self-contained: create a custom Role + Group granting use_terminal +
    // control_browser, seat the member (also in canonical `members`), then
    // edit the Role bundle and assert the member's affectedUserDeltas row.
    const roleSlug = `edit-role-${ts}`;
    const groupType = `custom:edit-${ts}`;
    const rp = await previewOperation(deps(), {
      actorUserId: ownerUserId,
      actorActorId: ownerActorId,
      operation: { kind: "role.create", slug: roleSlug, label: "EDIT", capabilities: ["use_terminal", "control_browser"] },
    });
    expect(rp.ok).toBe(true);
    const ra = await applyOperation(deps(), {
      actorUserId: ownerUserId,
      actorActorId: ownerActorId,
      operation: { kind: "role.create", slug: roleSlug, label: "EDIT", capabilities: ["use_terminal", "control_browser"] },
      fingerprint: rp.fingerprint,
    });
    expect(ra.applied).toBe(true);
    const [roleRow] = await db.select({ id: roles.id }).from(roles).where(eq(roles.slug, roleSlug)).limit(1);
    if (roleRow) createdRoleIds.push(roleRow.id);
    expect(roleRow).toBeDefined();

    const gp = await previewOperation(deps(), {
      actorUserId: ownerUserId,
      actorActorId: ownerActorId,
      operation: { kind: "group.create", groupType, label: "EDITG", ownerUserId: ownerUserId, roleSlugs: [roleSlug] },
    });
    expect(gp.ok).toBe(true);
    const ga = await applyOperation(deps(), {
      actorUserId: ownerUserId,
      actorActorId: ownerActorId,
      operation: { kind: "group.create", groupType, label: "EDITG", ownerUserId: ownerUserId, roleSlugs: [roleSlug] },
      fingerprint: gp.fingerprint,
    });
    expect(ga.applied).toBe(true);
    const [groupRow] = await db.select({ id: groups.id }).from(groups).where(eq(groups.type, groupType)).limit(1);
    if (groupRow) createdGroupIds.push(groupRow.id);
    expect(groupRow).toBeDefined();

    await db
      .insert(groupMembers)
      .values({ groupId: groupRow!.id, userId: memberUserId, grantedBy: ownerActorId })
      .onConflictDoNothing({ target: [groupMembers.groupId, groupMembers.userId] });

    // Edit the Role bundle: drop control_browser, add use_high_impact_tools.
    const sp = await previewOperation(deps(), {
      actorUserId: ownerUserId,
      actorActorId: ownerActorId,
      operation: { kind: "role.set_capabilities", roleId: roleRow!.id, capabilities: ["use_terminal", "use_high_impact_tools"] },
    });
    expect(sp.ok).toBe(true);
    const memberDelta = (sp.affectedUserDeltas ?? []).find((d) => d.userId === memberUserId);
    expect(memberDelta).toBeDefined();
    expect(memberDelta!.added).toEqual([]); // use_high_impact_tools already held via `members`
    expect(memberDelta!.removed).toEqual(["control_browser"]);
    // Robust against the real (large) Member bundle: control_browser is
    // gone, use_terminal is preserved (still granted by the edited Role),
    // and a known Member cap is preserved.
    const unchanged = memberDelta!.unchanged;
    expect(unchanged).toContain("use_terminal");
    expect(unchanged).toContain("use_workstation_profiles");
    expect(unchanged).not.toContain("control_browser");
    // Clean up this test's custom Group + Role so it cannot pollute the
    // later composite test (which asserts the member genuinely gains
    // use_terminal + control_browser via the new composite Group).
    await db.delete(groupMembers).where(eq(groupMembers.groupId, groupRow!.id));
    await db.delete(groups).where(eq(groups.id, groupRow!.id));
    await db.delete(roles).where(eq(roles.id, roleRow!.id));
    const gidx = createdGroupIds.indexOf(groupRow!.id);
    if (gidx >= 0) createdGroupIds.splice(gidx, 1);
    const ridx = createdRoleIds.indexOf(roleRow!.id);
    if (ridx >= 0) createdRoleIds.splice(ridx, 1);
  });

  test("W3.2.14 composite shared_access.create creates Role+Group+edge+members atomically with one audit event", async () => {
    const roleSlug = `cmp-role-${ts}`;
    const groupType = `custom:cmp-${ts}`;
    const beforeAuditCount = recordedAudit.length;
    const preview = await previewOperation(deps(), {
      actorUserId: ownerUserId,
      actorActorId: ownerActorId,
      operation: {
        kind: "shared_access.create",
        role: { slug: roleSlug, label: "CMP", capabilities: ["use_terminal", "control_browser"] },
        group: { groupType, label: "CMPG", ownerUserId: ownerUserId },
        memberUserIds: [memberUserId, memberUserId, ownerUserId],
      },
    });
    expect(preview.ok).toBe(true);
    expect(preview.auditPreview.kind).toBe("rbac_shared_access_created");
    // De-duped member count in the audit preview.
    expect((preview.auditPreview as { memberCount: number }).memberCount).toBe(2);
    // The owner already holds use_terminal + control_browser (Admin), so
    // the owner's delta is all-UNCHANGED; the member genuinely gains both.
    const ownerDelta = (preview.affectedUserDeltas ?? []).find((d) => d.userId === ownerUserId);
    expect(ownerDelta?.added).toEqual([]);
    const memberDelta = (preview.affectedUserDeltas ?? []).find((d) => d.userId === memberUserId);
    expect(memberDelta?.added).toEqual(["control_browser", "use_terminal"]);

    const apply = await applyOperation(deps(), {
      actorUserId: ownerUserId,
      actorActorId: ownerActorId,
      operation: {
        kind: "shared_access.create",
        role: { slug: roleSlug, label: "CMP", capabilities: ["use_terminal", "control_browser"] },
        group: { groupType, label: "CMPG", ownerUserId: ownerUserId },
        memberUserIds: [memberUserId, memberUserId, ownerUserId],
      },
      fingerprint: preview.fingerprint,
    });
    expect(apply.applied).toBe(true);
    if (apply.applied) expect(apply.auditRecorded).toBe(true);

    // Exactly one audit event was written for the whole composite.
    expect(recordedAudit.length - beforeAuditCount).toBe(1);
    expect(recordedAudit[recordedAudit.length - 1]!.kind).toBe("rbac_shared_access_created");

    const [roleRow] = await db.select({ id: roles.id }).from(roles).where(eq(roles.slug, roleSlug)).limit(1);
    if (roleRow) createdRoleIds.push(roleRow.id);
    expect(roleRow).toBeDefined();
    const [groupRow] = await db.select({ id: groups.id }).from(groups).where(eq(groups.type, groupType)).limit(1);
    if (groupRow) createdGroupIds.push(groupRow.id);
    expect(groupRow).toBeDefined();
    // Group→Role edge exists.
    const edges = await db.select().from(groupRoles).where(eq(groupRoles.groupId, groupRow!.id));
    expect(edges.length).toBe(1);
    expect(edges[0]!.roleId).toBe(roleRow!.id);
    // Both initial memberships exist (de-duped).
    const members = await db.select().from(groupMembers).where(eq(groupMembers.groupId, groupRow!.id));
    expect(members.map((m) => m.userId).sort()).toEqual([memberUserId, ownerUserId].sort());
  });

  test("W3.2.14 composite validation failure leaves no partial Role/Group/membership", async () => {
    const roleSlug = `fail-role-${ts}`;
    const groupType = `custom:fail-${ts}`;
    // Nondelegable cap → preview fails; apply with the (failing) preview's
    // fingerprint still rejects and writes nothing.
    const preview = await previewOperation(deps(), {
      actorUserId: ownerUserId,
      actorActorId: ownerActorId,
      operation: {
        kind: "shared_access.create",
        role: { slug: roleSlug, label: "FAIL", capabilities: ["manage_server_security"] },
        group: { groupType, label: "FAILG", ownerUserId: ownerUserId },
        memberUserIds: [memberUserId],
      },
    });
    expect(preview.ok).toBe(false);
    expect(preview.failures.map((f) => f.code)).toContain("nondelegable_capability");

    const apply = await applyOperation(deps(), {
      actorUserId: ownerUserId,
      actorActorId: ownerActorId,
      operation: {
        kind: "shared_access.create",
        role: { slug: roleSlug, label: "FAIL", capabilities: ["manage_server_security"] },
        group: { groupType, label: "FAILG", ownerUserId: ownerUserId },
        memberUserIds: [memberUserId],
      },
      fingerprint: preview.fingerprint,
    });
    expect(apply.applied).toBe(false);
    if (!apply.applied) expect(apply.code).toBe("authorization_denied");

    // Nothing was created.
    const [roleRow] = await db.select({ id: roles.id }).from(roles).where(eq(roles.slug, roleSlug)).limit(1);
    expect(roleRow).toBeUndefined();
    const [groupRow] = await db.select({ id: groups.id }).from(groups).where(eq(groups.type, groupType)).limit(1);
    expect(groupRow).toBeUndefined();
  });

  test("W3.2.14 composite missing one of three management caps is rejected", async () => {
    // Create a peer Admin who lacks manage_members by seating them only in
    // a custom group that grants manage_roles + manage_groups but NOT
    // manage_members. The composite requires all three → rejected.
    const mgrRoleSlug = `mgr-role-${ts}`;
    const mgrGroupType = `custom:mgr-${ts}`;
    const rp = await previewOperation(deps(), {
      actorUserId: ownerUserId,
      actorActorId: ownerActorId,
      operation: { kind: "role.create", slug: mgrRoleSlug, label: "MGR", capabilities: ["manage_roles", "manage_groups"] },
    });
    expect(rp.ok).toBe(true);
    const ra = await applyOperation(deps(), {
      actorUserId: ownerUserId,
      actorActorId: ownerActorId,
      operation: { kind: "role.create", slug: mgrRoleSlug, label: "MGR", capabilities: ["manage_roles", "manage_groups"] },
      fingerprint: rp.fingerprint,
    });
    expect(ra.applied).toBe(true);
    const [mgrRole] = await db.select({ id: roles.id }).from(roles).where(eq(roles.slug, mgrRoleSlug)).limit(1);
    if (mgrRole) createdRoleIds.push(mgrRole.id);

    const gp = await previewOperation(deps(), {
      actorUserId: ownerUserId,
      actorActorId: ownerActorId,
      operation: { kind: "group.create", groupType: mgrGroupType, label: "MGRG", ownerUserId: ownerUserId, roleSlugs: [mgrRoleSlug] },
    });
    expect(gp.ok).toBe(true);
    const ga = await applyOperation(deps(), {
      actorUserId: ownerUserId,
      actorActorId: ownerActorId,
      operation: { kind: "group.create", groupType: mgrGroupType, label: "MGRG", ownerUserId: ownerUserId, roleSlugs: [mgrRoleSlug] },
      fingerprint: gp.fingerprint,
    });
    expect(ga.applied).toBe(true);
    const [mgrGroup] = await db.select({ id: groups.id }).from(groups).where(eq(groups.type, mgrGroupType)).limit(1);
    if (mgrGroup) createdGroupIds.push(mgrGroup.id);

    // Create a peer user seated ONLY in the mgr group (holds manage_roles +
    // manage_groups, but NOT manage_members).
    const [peer] = await db
      .insert(users)
      .values({
        name: "s195w32-peer",
        email: `s195w32-p-${ts}@test.local`,
        handle: `s195w32p${ts.slice(-6)}`,
        externalId: `s195w32-p-${ts}`,
      })
      .returning({ id: users.id });
    if (!peer) throw new Error("peer insert failed");
    createdUserIds.push(peer.id);
    await db
      .insert(groupMembers)
      .values({ groupId: mgrGroup!.id, userId: peer.id, grantedBy: ownerActorId })
      .onConflictDoNothing({ target: [groupMembers.groupId, groupMembers.userId] });

    const preview = await previewOperation(deps(), {
      actorUserId: peer.id,
      actorActorId: ownerActorId,
      operation: {
        kind: "shared_access.create",
        role: { slug: `peer-${ts}`, label: "P", capabilities: ["use_terminal"] },
        group: { groupType: `custom:peer-${ts}`, label: "PG", ownerUserId: peer.id },
        memberUserIds: [peer.id],
      },
    });
    expect(preview.ok).toBe(false);
    expect(preview.failures.map((f) => f.code)).toContain("missing_manage_members");
  });
});

describe("Stack 195 W3.2.14 — shared_access.assign_existing (real DB)", () => {
  test("preview then apply attaches an existing custom Role to a new Group + initial members atomically", async () => {
    // First create a custom Permission set (Role) to attach.
    const roleSlug = `asg-role-${ts}`;
    const rp = await previewOperation(deps(), {
      actorUserId: ownerUserId,
      actorActorId: ownerActorId,
      operation: { kind: "role.create", slug: roleSlug, label: "ASG", capabilities: ["use_terminal", "control_browser"] },
    });
    expect(rp.ok).toBe(true);
    const ra = await applyOperation(deps(), {
      actorUserId: ownerUserId,
      actorActorId: ownerActorId,
      operation: { kind: "role.create", slug: roleSlug, label: "ASG", capabilities: ["use_terminal", "control_browser"] },
      fingerprint: rp.fingerprint,
    });
    expect(ra.applied).toBe(true);
    const [roleRow] = await db.select({ id: roles.id }).from(roles).where(eq(roles.slug, roleSlug)).limit(1);
    if (roleRow) createdRoleIds.push(roleRow.id);
    expect(roleRow).toBeDefined();

    // A FRESH Human for this test's initial member, so leftover memberships
    // from earlier composite tests (which seat `memberUserId` in a
    // use_terminal+control_browser group) cannot make the assign_existing
    // delta all-UNCHANGED. The fresh user holds nothing today.
    const [freshMember] = await db
      .insert(users)
      .values({
        name: "s195w32-asg-member",
        email: `s195w32-asg-m-${ts}@test.local`,
        handle: `s195w32asgm${ts.slice(-6)}`,
        externalId: `s195w32-asg-m-${ts}`,
      })
      .returning({ id: users.id });
    if (!freshMember) throw new Error("fresh member insert failed");
    createdUserIds.push(freshMember.id);

    const groupType = `custom:asg-${ts}`;
    const beforeAuditCount = recordedAudit.length;
    const preview = await previewOperation(deps(), {
      actorUserId: ownerUserId,
      actorActorId: ownerActorId,
      operation: {
        kind: "shared_access.assign_existing",
        roleSlug,
        group: { groupType, label: "ASGG", ownerUserId: ownerUserId },
        memberUserIds: [freshMember.id, freshMember.id, ownerUserId],
      },
    });
    expect(preview.ok).toBe(true);
    expect(preview.auditPreview.kind).toBe("rbac_shared_access_assigned");
    // De-duped member count in the audit preview.
    expect((preview.auditPreview as { memberCount: number }).memberCount).toBe(2);
    // The audit preview carries the EXISTING role's real id + slug + bundle.
    expect((preview.auditPreview as { roleId: string }).roleId).toBe(roleRow!.id);
    expect((preview.auditPreview as { roleSlug: string }).roleSlug).toBe(roleSlug);
    expect(
      [...(preview.auditPreview as { capabilities: readonly string[] }).capabilities].sort(),
    ).toEqual(["control_browser", "use_terminal"]);
    // The owner already holds both caps (Admin), so the owner's delta is
    // all-UNCHANGED; the fresh member genuinely gains both.
    const ownerDelta = (preview.affectedUserDeltas ?? []).find((d) => d.userId === ownerUserId);
    expect(ownerDelta?.added).toEqual([]);
    const memberDelta = (preview.affectedUserDeltas ?? []).find((d) => d.userId === freshMember.id);
    expect(memberDelta?.added).toEqual(["control_browser", "use_terminal"]);

    const apply = await applyOperation(deps(), {
      actorUserId: ownerUserId,
      actorActorId: ownerActorId,
      operation: {
        kind: "shared_access.assign_existing",
        roleSlug,
        group: { groupType, label: "ASGG", ownerUserId: ownerUserId },
        memberUserIds: [freshMember.id, freshMember.id, ownerUserId],
      },
      fingerprint: preview.fingerprint,
    });
    expect(apply.applied).toBe(true);
    if (apply.applied) expect(apply.auditRecorded).toBe(true);

    // Exactly one audit event was written for the whole composite.
    expect(recordedAudit.length - beforeAuditCount).toBe(1);
    expect(recordedAudit[recordedAudit.length - 1]!.kind).toBe("rbac_shared_access_assigned");

    // The Role row is unchanged (no new role created).
    const roleRows = await db.select({ id: roles.id }).from(roles).where(eq(roles.slug, roleSlug));
    expect(roleRows.length).toBe(1);
    // The new Group exists.
    const [groupRow] = await db.select({ id: groups.id }).from(groups).where(eq(groups.type, groupType)).limit(1);
    if (groupRow) createdGroupIds.push(groupRow.id);
    expect(groupRow).toBeDefined();
    // Group→existing-Role edge exists.
    const edges = await db.select().from(groupRoles).where(eq(groupRoles.groupId, groupRow!.id));
    expect(edges.length).toBe(1);
    expect(edges[0]!.roleId).toBe(roleRow!.id);
    // Both initial memberships exist (de-duped).
    const members = await db.select().from(groupMembers).where(eq(groupMembers.groupId, groupRow!.id));
    expect(members.map((m) => m.userId).sort()).toEqual([freshMember.id, ownerUserId].sort());
  });

  test("assign_existing validation failure (canonical role) leaves no partial Group/edge/members", async () => {
    const groupType = `custom:asgfail-${ts}`;
    const preview = await previewOperation(deps(), {
      actorUserId: ownerUserId,
      actorActorId: ownerActorId,
      operation: {
        kind: "shared_access.assign_existing",
        roleSlug: "admin",
        group: { groupType, label: "FAILG", ownerUserId: ownerUserId },
        memberUserIds: [memberUserId],
      },
    });
    expect(preview.ok).toBe(false);
    expect(preview.failures.map((f) => f.code)).toContain("protected_definition");

    const apply = await applyOperation(deps(), {
      actorUserId: ownerUserId,
      actorActorId: ownerActorId,
      operation: {
        kind: "shared_access.assign_existing",
        roleSlug: "admin",
        group: { groupType, label: "FAILG", ownerUserId: ownerUserId },
        memberUserIds: [memberUserId],
      },
      fingerprint: preview.fingerprint,
    });
    expect(apply.applied).toBe(false);
    if (!apply.applied) expect(apply.code).toBe("authorization_denied");

    // Nothing was created.
    const [noGroup] = await db.select({ id: groups.id }).from(groups).where(eq(groups.type, groupType)).limit(1);
    expect(noGroup).toBeUndefined();
  });

  test("assign_existing does NOT require manage_roles (manager with groups+members but not roles succeeds)", async () => {
    // Create a custom manager Role bundling manage_groups + manage_members +
    // use_terminal (NOT manage_roles), and a custom Group seating a peer in it.
    const mgrRoleSlug = `asg-mgr-${ts}`;
    const mgrGroupType = `custom:asg-mgr-${ts}`;
    const mrp = await previewOperation(deps(), {
      actorUserId: ownerUserId,
      actorActorId: ownerActorId,
      operation: { kind: "role.create", slug: mgrRoleSlug, label: "MGR", capabilities: ["manage_groups", "manage_members", "use_terminal"] },
    });
    expect(mrp.ok).toBe(true);
    const mra = await applyOperation(deps(), {
      actorUserId: ownerUserId,
      actorActorId: ownerActorId,
      operation: { kind: "role.create", slug: mgrRoleSlug, label: "MGR", capabilities: ["manage_groups", "manage_members", "use_terminal"] },
      fingerprint: mrp.fingerprint,
    });
    expect(mra.applied).toBe(true);
    const [mgrRole] = await db.select({ id: roles.id }).from(roles).where(eq(roles.slug, mgrRoleSlug)).limit(1);
    if (mgrRole) createdRoleIds.push(mgrRole.id);

    const mgp = await previewOperation(deps(), {
      actorUserId: ownerUserId,
      actorActorId: ownerActorId,
      operation: { kind: "group.create", groupType: mgrGroupType, label: "MGRG", ownerUserId: ownerUserId, roleSlugs: [mgrRoleSlug] },
    });
    expect(mgp.ok).toBe(true);
    const mga = await applyOperation(deps(), {
      actorUserId: ownerUserId,
      actorActorId: ownerActorId,
      operation: { kind: "group.create", groupType: mgrGroupType, label: "MGRG", ownerUserId: ownerUserId, roleSlugs: [mgrRoleSlug] },
      fingerprint: mgp.fingerprint,
    });
    expect(mga.applied).toBe(true);
    const [mgrGroup] = await db.select({ id: groups.id }).from(groups).where(eq(groups.type, mgrGroupType)).limit(1);
    if (mgrGroup) createdGroupIds.push(mgrGroup.id);

    // Create an existing custom Permission set bundling only use_terminal
    // (which the peer manager holds) so the peer has authority over it.
    const existingRoleSlug = `asg-existing-${ts}`;
    const erp = await previewOperation(deps(), {
      actorUserId: ownerUserId,
      actorActorId: ownerActorId,
      operation: { kind: "role.create", slug: existingRoleSlug, label: "EXIST", capabilities: ["use_terminal"] },
    });
    expect(erp.ok).toBe(true);
    const era = await applyOperation(deps(), {
      actorUserId: ownerUserId,
      actorActorId: ownerActorId,
      operation: { kind: "role.create", slug: existingRoleSlug, label: "EXIST", capabilities: ["use_terminal"] },
      fingerprint: erp.fingerprint,
    });
    expect(era.applied).toBe(true);
    const [existingRole] = await db.select({ id: roles.id }).from(roles).where(eq(roles.slug, existingRoleSlug)).limit(1);
    if (existingRole) createdRoleIds.push(existingRole.id);

    // Peer: seated ONLY in the manager group → holds manage_groups +
    // manage_members + use_terminal, but NOT manage_roles.
    const [peer] = await db
      .insert(users)
      .values({
        name: "s195w32-asg-peer",
        email: `s195w32-asg-p-${ts}@test.local`,
        handle: `s195w32asgp${ts.slice(-6)}`,
        externalId: `s195w32-asg-p-${ts}`,
      })
      .returning({ id: users.id });
    if (!peer) throw new Error("peer insert failed");
    createdUserIds.push(peer.id);
    await db
      .insert(groupMembers)
      .values({ groupId: mgrGroup!.id, userId: peer.id, grantedBy: ownerActorId })
      .onConflictDoNothing({ target: [groupMembers.groupId, groupMembers.userId] });

    const assignGroupType = `custom:asg-peer-${ts}`;
    const preview = await previewOperation(deps(), {
      actorUserId: peer.id,
      actorActorId: ownerActorId,
      operation: {
        kind: "shared_access.assign_existing",
        roleSlug: existingRoleSlug,
        group: { groupType: assignGroupType, label: "PEERG", ownerUserId: peer.id },
        memberUserIds: [peer.id],
      },
    });
    // manage_roles is NOT required → the peer (who lacks it) is authorized.
    expect(preview.ok).toBe(true);
    expect(preview.failures.map((f) => f.code)).not.toContain("missing_manage_roles");
    expect(preview.failures.map((f) => f.code)).not.toContain("missing_manage_groups");
    expect(preview.failures.map((f) => f.code)).not.toContain("missing_manage_members");

    const apply = await applyOperation(deps(), {
      actorUserId: peer.id,
      actorActorId: ownerActorId,
      operation: {
        kind: "shared_access.assign_existing",
        roleSlug: existingRoleSlug,
        group: { groupType: assignGroupType, label: "PEERG", ownerUserId: peer.id },
        memberUserIds: [peer.id],
      },
      fingerprint: preview.fingerprint,
    });
    expect(apply.applied).toBe(true);
    const [peerGroup] = await db.select({ id: groups.id }).from(groups).where(eq(groups.type, assignGroupType)).limit(1);
    if (peerGroup) createdGroupIds.push(peerGroup.id);
    expect(peerGroup).toBeDefined();
    const edges = await db.select().from(groupRoles).where(eq(groupRoles.groupId, peerGroup!.id));
    expect(edges[0]!.roleId).toBe(existingRole!.id);
  });
});

// ---------------------------------------------------------------------------
// Stack 195 follow-up — sole-Owner removal preview/apply parity against the
// real DB. The preview MUST surface a stable `last_owner` check (bypass false
// AND true), apply MUST map the same invariant to the stable 409 `last_owner`
// the routes return (re-raised as `MembershipOpError("last_owner")`) WITHOUT
// running execute, and a multi-Owner removal MUST stay allowed. The fixture
// seeds the admins ladder but not the owners ladder, so the owner Role +
// owners→owner edge + full owner bundle are ensured idempotently here, and
// the owners membership is snapshotted + restored exactly in a try/finally so
// the shared scratch DB is left undisturbed.
// ---------------------------------------------------------------------------

describe("Stack 195 follow-up — sole-Owner removal preview/apply parity (real DB)", () => {
  test(
    "preview rejects the sole Owner (bypass false/true); apply maps to last_owner without executing; multi-Owner allowed",
    async () => {
      const [ownersGroup] = await db
        .select({ id: groups.id })
        .from(groups)
        .where(eq(groups.type, "owners"))
        .limit(1);
      if (!ownersGroup) return; // canonical owners Group absent; nothing to exercise

      // Idempotently ensure the owner Role + owners→owner edge + full owner
      // bundle exist so a member of owners actually holds the Owner bundle
      // (and therefore has authority to attempt a removal from owners).
      await db
        .insert(roles)
        .values({ slug: "owner", label: "Owner", isSystem: true })
        .onConflictDoNothing({ target: roles.slug });
      const [ownerRole] = await db
        .select({ id: roles.id })
        .from(roles)
        .where(eq(roles.slug, "owner"))
        .limit(1);
      if (!ownerRole) throw new Error("owner role seed failed");
      await db
        .insert(groupRoles)
        .values({ groupId: ownersGroup.id, roleId: ownerRole.id })
        .onConflictDoNothing();
      const capRows = await db.select({ id: capabilities.id, slug: capabilities.slug }).from(capabilities);
      await db
        .insert(roleCapabilities)
        .values(capRows.map((c) => ({ roleId: ownerRole.id, capabilityId: c.id })))
        .onConflictDoNothing();

      // Snapshot the current owners set so it can be restored exactly.
      const originalOwnerIds = (
        await db
          .select({ userId: groupMembers.userId })
          .from(groupMembers)
          .where(eq(groupMembers.groupId, ownersGroup.id))
      ).map((r) => r.userId);

      try {
        // Reset owners to a single, controlled Owner for the sole-Owner rail.
        await db.delete(groupMembers).where(eq(groupMembers.groupId, ownersGroup.id));
        await db
          .insert(groupMembers)
          .values({ groupId: ownersGroup.id, userId: ownerUserId, grantedBy: ownerActorId })
          .onConflictDoNothing({ target: [groupMembers.groupId, groupMembers.userId] });

        // --- preview rejects the sole Owner (bypass=false) ---
        const rp = await previewOperation(deps(), {
          actorUserId: ownerUserId,
          actorActorId: ownerActorId,
          operation: { kind: "membership.remove", groupId: ownersGroup.id, userId: ownerUserId },
        });
        expect(rp.ok).toBe(false);
        expect(rp.failures.map((f) => f.code)).toContain("last_owner");
        expect(rp.failures.find((f) => f.code === "last_owner")?.detail).toBe(
          "removing the sole Owner would leave zero Owners",
        );

        // --- preview rejects the sole Owner REGARDLESS of bypassLastOwner ---
        const rpBypass = await previewOperation(deps(), {
          actorUserId: ownerUserId,
          actorActorId: ownerActorId,
          operation: {
            kind: "membership.remove",
            groupId: ownersGroup.id,
            userId: ownerUserId,
            bypassLastOwner: true,
          },
        });
        expect(rpBypass.ok).toBe(false);
        expect(rpBypass.failures.map((f) => f.code)).toContain("last_owner");

        // --- apply maps the rejected preview to the stable 409 last_owner
        // invariant WITHOUT running execute (the sole Owner stays) ---
        let applyErr: unknown;
        try {
          await applyOperation(deps(), {
            actorUserId: ownerUserId,
            actorActorId: ownerActorId,
            operation: {
              kind: "membership.remove",
              groupId: ownersGroup.id,
              userId: ownerUserId,
              bypassLastOwner: true,
            },
            fingerprint: rpBypass.fingerprint,
          });
        } catch (e) {
          applyErr = e;
        }
        expect(applyErr).toBeInstanceOf(MembershipOpError);
        expect((applyErr as MembershipOpError).opCode).toBe("last_owner");
        const stillSole = await db
          .select({ userId: groupMembers.userId })
          .from(groupMembers)
          .where(eq(groupMembers.groupId, ownersGroup.id))
          .limit(1);
        expect(stillSole.length).toBe(1);
        expect(stillSole[0]!.userId).toBe(ownerUserId);

        // --- multi-Owner removal stays allowed (the rail does not fire) ---
        await db
          .insert(groupMembers)
          .values({ groupId: ownersGroup.id, userId: memberUserId, grantedBy: ownerActorId })
          .onConflictDoNothing({ target: [groupMembers.groupId, groupMembers.userId] });
        const mp = await previewOperation(deps(), {
          actorUserId: ownerUserId,
          actorActorId: ownerActorId,
          operation: { kind: "membership.remove", groupId: ownersGroup.id, userId: memberUserId },
        });
        expect(mp.ok).toBe(true);
        expect(mp.failures.map((f) => f.code)).not.toContain("last_owner");
        const ma = await applyOperation(deps(), {
          actorUserId: ownerUserId,
          actorActorId: ownerActorId,
          operation: { kind: "membership.remove", groupId: ownersGroup.id, userId: memberUserId },
          fingerprint: mp.fingerprint,
        });
        expect(ma.applied).toBe(true);
        const afterMulti = await db
          .select({ userId: groupMembers.userId })
          .from(groupMembers)
          .where(eq(groupMembers.groupId, ownersGroup.id));
        expect(afterMulti.map((r) => r.userId)).toEqual([ownerUserId]);
      } finally {
        // Restore the exact original owners set.
        await db.delete(groupMembers).where(eq(groupMembers.groupId, ownersGroup.id));
        if (originalOwnerIds.length > 0) {
          await db
            .insert(groupMembers)
            .values(
              originalOwnerIds.map((uid) => ({
                groupId: ownersGroup.id,
                userId: uid,
                grantedBy: ownerActorId,
              })),
            )
            .onConflictDoNothing({ target: [groupMembers.groupId, groupMembers.userId] });
        }
      }
    },
    120000,
  );
});
