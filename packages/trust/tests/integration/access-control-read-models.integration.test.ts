/**
 * Stack 195 / W3.1 — integration coverage for the read-only effective-access
 * + catalogue read models against the real DB. Mirrors the established trust
 * integration pattern (seed what the test needs; clean up custom rows).
 */
import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../.env") });

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  capabilities,
  createDirectDb,
  eq,
  groupMembers,
  groupRoles,
  groups,
  inArray,
  roleCapabilities,
  roles,
  users,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { ensureDatabase } from "@nautilo/db";
import {
  getAccessControlCatalogue,
  getEffectiveAccessForUser,
} from "../../src/access-control-read-models";

let db: ReturnType<typeof createDirectDb>;
let testUserId: string;
const ts = Date.now().toString(36);
const customRoleSlug = `mobile-dev-${ts}`;
const customGroupType = `custom:mobile-${ts}`;
const createdCapSlugs = new Set<string>();
const createdRoleIds: string[] = [];
const createdGroupIds: string[] = [];

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(1);

  const [user] = await db
    .insert(users)
    .values({
      name: "s195w31-int-user",
      email: `s195w31-${ts}@test.local`,
      handle: `s195w31${ts.slice(-6)}`,
    })
    .returning({ id: users.id });
  if (!user) throw new Error("test user insert failed");
  testUserId = user.id;

  // Seed capabilities (idempotent).
  const capSeeds = [
    { slug: "use_workstation_profiles", description: "Activate a profile", category: "devices" },
    { slug: "use_high_impact_tools", description: "High impact tools", category: "tools" },
    { slug: "use_terminal", description: "Terminal", category: "devices" },
    { slug: "control_browser", description: "Browser", category: "devices" },
  ];
  await db.insert(capabilities).values(capSeeds).onConflictDoNothing({ target: capabilities.slug });
  for (const c of capSeeds) createdCapSlugs.add(c.slug);
  const allCaps = await db.select().from(capabilities);
  const capId = (slug: string) => allCaps.find((c) => c.slug === slug)?.id;

  // Seed canonical 'member' role (system) if absent + its bundle subset.
  await db
    .insert(roles)
    .values({ slug: "member", label: "Member", isSystem: true })
    .onConflictDoNothing({ target: roles.slug });
  const memberCapRows = [
    { roleId: (await db.select().from(roles).where(eq(roles.slug, "member")).limit(1))[0]!.id, capabilityId: capId("use_workstation_profiles")! },
    { roleId: (await db.select().from(roles).where(eq(roles.slug, "member")).limit(1))[0]!.id, capabilityId: capId("use_high_impact_tools")! },
  ];
  await db.insert(roleCapabilities).values(memberCapRows).onConflictDoNothing();

  // Custom role + bundle.
  const [customRole] = await db
    .insert(roles)
    .values({ slug: customRoleSlug, label: "Mobile Dev", isSystem: false })
    .returning({ id: roles.id });
  if (!customRole) throw new Error("custom role insert failed");
  createdRoleIds.push(customRole.id);
  await db
    .insert(roleCapabilities)
    .values([
      { roleId: customRole.id, capabilityId: capId("use_terminal")! },
      { roleId: customRole.id, capabilityId: capId("control_browser")! },
    ])
    .onConflictDoNothing();

  // Canonical 'members' group (system) — reuse if present.
  await db
    .insert(groups)
    .values({ type: "members", label: "Members", isSystem: true, trustPreset: "personal" })
    .onConflictDoNothing({ target: groups.type });
  const membersGroup = (await db.select().from(groups).where(eq(groups.type, "members")).limit(1))[0]!;

  // Custom group (owner = test user) carrying the custom role.
  const [customGroup] = await db
    .insert(groups)
    .values({ type: customGroupType, label: "Mobile", isSystem: false, ownerId: testUserId, trustPreset: "personal" })
    .returning({ id: groups.id });
  if (!customGroup) throw new Error("custom group insert failed");
  createdGroupIds.push(customGroup.id);
  await db
    .insert(groupRoles)
    .values({ groupId: customGroup.id, roleId: customRole.id })
    .onConflictDoNothing();

  // Seat the test user in both groups.
  await db
    .insert(groupMembers)
    .values([
      { groupId: membersGroup.id, userId: testUserId },
      { groupId: customGroup.id, userId: testUserId },
    ])
    .onConflictDoNothing({ target: [groupMembers.groupId, groupMembers.userId] });
});

afterAll(async () => {
  if (!db) return;
  try {
    // Remove the test user's memberships (do NOT delete canonical groups).
    await db.delete(groupMembers).where(eq(groupMembers.userId, testUserId));
    // Delete custom group (cascades group_roles + group_members).
    if (createdGroupIds.length > 0) {
      await db.delete(groups).where(inArray(groups.id, createdGroupIds));
    }
    // Delete custom role (cascades role_capabilities + group_roles).
    if (createdRoleIds.length > 0) {
      await db.delete(roles).where(inArray(roles.id, createdRoleIds));
    }
    await db.delete(users).where(eq(users.id, testUserId));
  } finally {
    await db.end();
  }
});

describe("Stack 195 W3.1 — getEffectiveAccessForUser (real DB)", () => {
  test("returns null for an unknown user", async () => {
    const out = await getEffectiveAccessForUser("00000000-0000-0000-0000-000000000000");
    expect(out).toBe(null);
  });

  test("Member + custom Role union: highestRole stays member; every path preserved", async () => {
    const out = await getEffectiveAccessForUser(testUserId);
    expect(out).not.toBe(null);
    if (!out) return;

    // Custom role does not alter the canonical ladder rank.
    expect(out.highestRole).toBe("member");

    // use_workstation_profiles granted via the canonical member/members path.
    const wsl = out.capabilities.find((c) => c.slug === "use_workstation_profiles")!;
    expect(wsl.granted).toBe(true);
    expect(
      wsl.provenance.some((p) => p.roleSlug === "member" && p.groupType === "members"),
    ).toBe(true);
    expect(wsl.provenance.every((p) => p.roleSlug !== customRoleSlug)).toBe(true);

    // use_terminal granted via the custom role on the custom group.
    const terminal = out.capabilities.find((c) => c.slug === "use_terminal")!;
    expect(terminal.granted).toBe(true);
    expect(terminal.provenance).toHaveLength(1);
    const termPath = terminal.provenance[0]!;
    expect(termPath.roleSlug).toBe(customRoleSlug);
    expect(termPath.groupType).toBe(customGroupType);
    expect(termPath.groupIsSystem).toBe(false);
    expect(termPath.roleIsSystem).toBe(false);
    expect(termPath.groupOwnerId).toBe(testUserId);

    // Both groups appear; the custom group carries its ownerId.
    const customGroup = out.groups.find((g) => g.type === customGroupType)!;
    expect(customGroup.isSystem).toBe(false);
    expect(customGroup.ownerId).toBe(testUserId);
    expect(customGroup.roleSlugs).toEqual([customRoleSlug]);
    const membersGroup = out.groups.find((g) => g.type === "members")!;
    expect(membersGroup.isSystem).toBe(true);

    // Both roles appear (custom role appears here too).
    expect(out.roles.map((r) => r.slug).sort()).toEqual(["member", customRoleSlug].sort());
    const customRoleSummary = out.roles.find((r) => r.slug === customRoleSlug)!;
    expect(customRoleSummary.isSystem).toBe(false);
    expect([...customRoleSummary.capabilitySlugs].sort()).toEqual(
      ["control_browser", "use_terminal"].sort(),
    );

    // group-role facts: one per (group, role) pair across both groups.
    expect(out.groupRoleFacts.length).toBeGreaterThanOrEqual(2);
    const customFact = out.groupRoleFacts.find((f) => f.roleSlug === customRoleSlug)!;
    expect([...customFact.capabilitySlugs].sort()).toEqual(["control_browser", "use_terminal"].sort());
  });
});

describe("Stack 195 W3.1 — getAccessControlCatalogue (real DB)", () => {
  test("returns server-truth capabilities, roles, and groups", async () => {
    const cat = await getAccessControlCatalogue();

    // Capabilities come from the DB (server truth), in stable order.
    const capSlugs = cat.capabilities.map((c) => c.slug);
    expect(capSlugs).toContain("use_workstation_profiles");
    expect(capSlugs).toContain("use_terminal");
    // Stable order: known canonical slugs follow CAPABILITY_SLUGS ordering
    // (use_terminal=19 precedes use_workstation_profiles=22).
    const wslIdx = capSlugs.indexOf("use_workstation_profiles");
    const terminalIdx = capSlugs.indexOf("use_terminal");
    expect(wslIdx).toBeGreaterThan(-1);
    expect(terminalIdx).toBeGreaterThan(-1);
    expect(terminalIdx).toBeLessThan(wslIdx);

    // Custom role summary present with its bundle + groupCount.
    const customRole = cat.roles.find((r) => r.slug === customRoleSlug)!;
    expect(customRole).toBeDefined();
    expect(customRole.isSystem).toBe(false);
    expect([...customRole.capabilitySlugs].sort()).toEqual(
      ["control_browser", "use_terminal"].sort(),
    );
    expect(customRole.groupCount).toBeGreaterThanOrEqual(1);

    // Canonical 'member' role is present and marked system.
    const memberRole = cat.roles.find((r) => r.slug === "member");
    expect(memberRole).toBeDefined();
    expect(memberRole!.isSystem).toBe(true);

    // Custom group summary present with ownerId + memberCount + roleSlugs.
    const customGroup = cat.groups.find((g) => g.type === customGroupType)!;
    expect(customGroup).toBeDefined();
    expect(customGroup.isSystem).toBe(false);
    expect(customGroup.ownerId).toBe(testUserId);
    expect(customGroup.memberCount).toBeGreaterThanOrEqual(1);
    expect(customGroup.roleSlugs).toEqual([customRoleSlug]);

    // Canonical 'members' group is present and marked system with null owner.
    const membersGroup = cat.groups.find((g) => g.type === "members");
    expect(membersGroup).toBeDefined();
    expect(membersGroup!.isSystem).toBe(true);
    expect(membersGroup!.ownerId).toBe(null);
  });
});
