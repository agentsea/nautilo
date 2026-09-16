/**
 * Stack 195 / W3.1.1 / W3.1.7 — unit coverage for the pure effective-access
 * folding helpers in `access-control-read-models.ts`. No database.
 *
 * Acceptance matrix (wave-3-stack-195-tasks.md W3.1.7):
 *   - Member + custom Role union preserves every Group -> Role -> Capability path.
 *   - Contributor + custom development Role union.
 *   - Multiple Roles on one Group preserve every provenance path.
 *   - A custom Role never alters the highest canonical ladder Role.
 *   - Full capability catalogue is returned in stable order with granted/
 *     not-granted + all provenance paths for granted rows.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildEffectiveAccess,
  computeHighestCanonicalRole,
  type EffectiveAccessPathRow,
  type CatalogueCapabilityRow,
} from "../../src/access-control-read-models";

const TRUST_ROOT = join(import.meta.dir, "..", "..");
const TRUST_SOURCE_DIR = join(TRUST_ROOT, "src");
const DIRECT_DRIZZLE_IMPORT = /\bfrom\s+["']drizzle-orm(?:\/[^"']*)?["']/;

test("trust queries use the @nautilo/db Drizzle facade", () => {
  const directImports = readdirSync(TRUST_SOURCE_DIR, { recursive: true })
    .filter((entry): entry is string => typeof entry === "string" && entry.endsWith(".ts"))
    .filter((entry) => DIRECT_DRIZZLE_IMPORT.test(readFileSync(join(TRUST_SOURCE_DIR, entry), "utf8")));

  expect(directImports).toEqual([]);

  const packageJson = JSON.parse(readFileSync(join(TRUST_ROOT, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  expect(packageJson.dependencies?.["drizzle-orm"]).toBeUndefined();
});

const CATALOGUE: CatalogueCapabilityRow[] = [
  { slug: "use_workstation", description: "Use the workstation", category: "devices" },
  { slug: "use_project_execution", description: "Execute project tools", category: "tools" },
  { slug: "use_remote_hosts", description: "Use remote hosts", category: "devices" },
  { slug: "control_browser", description: "Browser", category: "devices" },
  { slug: "control_desktop", description: "Desktop", category: "devices" },
  { slug: "manage_members", description: "Manage members", category: "identity" },
];

function path(
  group: { id: string; type: string; label: string; isSystem: boolean; ownerId: string | null },
  role: { slug: string; label: string; isSystem: boolean },
  cap: string | null,
): EffectiveAccessPathRow {
  return {
    groupId: group.id,
    groupType: group.type,
    groupLabel: group.label,
    groupIsSystem: group.isSystem,
    groupOwnerId: group.ownerId,
    roleSlug: role.slug,
    roleLabel: role.label,
    roleIsSystem: role.isSystem,
    capabilitySlug: cap,
  };
}

const MEMBERS_GROUP = { id: "g-members", type: "members", label: "Members", isSystem: true, ownerId: null };
const CONTRIBUTORS_GROUP = { id: "g-contrib", type: "contributors", label: "Contributors", isSystem: true, ownerId: null };
const CUSTOM_GROUP = { id: "g-custom", type: "custom:mobile", label: "Mobile", isSystem: false, ownerId: "u-owner" };

const MEMBER_ROLE = { slug: "member", label: "Member", isSystem: true };
const CONTRIBUTOR_ROLE = { slug: "contributor", label: "Contributor", isSystem: true };
const CUSTOM_ROLE = { slug: "mobile-dev", label: "Mobile Dev", isSystem: false };

const USER = { id: "u-1", handle: "ada", displayName: "Ada", server: null };

describe("computeHighestCanonicalRole", () => {
  test("returns the highest-rank canonical ladder Role across the user's Roles", () => {
    expect(computeHighestCanonicalRole(["member", "admin"])).toBe("admin");
    expect(computeHighestCanonicalRole(["guest", "owner", "member"])).toBe("owner");
  });

  test("skips custom Roles (they never influence the canonical rank)", () => {
    expect(computeHighestCanonicalRole(["mobile-dev", "member"])).toBe("member");
    expect(computeHighestCanonicalRole(["mobile-dev", "qa-role"])).toBe(null);
  });

  test("returns null when the user holds no canonical ladder Role", () => {
    expect(computeHighestCanonicalRole([])).toBe(null);
    expect(computeHighestCanonicalRole(["mobile-dev"])).toBe(null);
  });
});

describe("buildEffectiveAccess — W3.1.7 matrix", () => {
  test("Member + custom Role union preserves every Group -> Role -> Capability path", () => {
    const rows: EffectiveAccessPathRow[] = [
      // members Group -> member Role -> two caps
      path(MEMBERS_GROUP, MEMBER_ROLE, "use_workstation"),
      path(MEMBERS_GROUP, MEMBER_ROLE, "use_project_execution"),
      // custom Group -> custom Role -> two caps
      path(CUSTOM_GROUP, CUSTOM_ROLE, "use_remote_hosts"),
      path(CUSTOM_GROUP, CUSTOM_ROLE, "control_browser"),
    ];
    const out = buildEffectiveAccess(USER, rows, CATALOGUE);

    // Highest canonical Role is Member; the custom Role does not alter it.
    expect(out.highestRole).toBe("member");

    // The union of capabilities spans both the canonical and custom paths.
    const granted = out.capabilities.filter((c) => c.granted).map((c) => c.slug);
    expect(granted.sort()).toEqual(
      ["use_project_execution", "use_remote_hosts", "use_workstation", "control_browser"].sort(),
    );

    // use_remote_hosts is granted ONLY via the custom path.
    const remoteHosts = out.capabilities.find((c) => c.slug === "use_remote_hosts")!;
    expect(remoteHosts.granted).toBe(true);
    expect(remoteHosts.provenance).toHaveLength(1);
    const remoteHostsPath = remoteHosts.provenance[0]!;
    expect(remoteHostsPath.groupType).toBe("custom:mobile");
    expect(remoteHostsPath.roleSlug).toBe("mobile-dev");
    expect(remoteHostsPath.groupIsSystem).toBe(false);
    expect(remoteHostsPath.roleIsSystem).toBe(false);

    // use_workstation is granted ONLY via the canonical Member path.
    const workstation = out.capabilities.find((c) => c.slug === "use_workstation")!;
    expect(workstation.provenance).toHaveLength(1);
    const workstationPath = workstation.provenance[0]!;
    expect(workstationPath.groupType).toBe("members");
    expect(workstationPath.roleSlug).toBe("member");
    expect(workstationPath.groupIsSystem).toBe(true);
    expect(workstationPath.roleIsSystem).toBe(true);

    // Both Groups appear; the custom Group carries its ownerId.
    expect(out.groups.map((g) => g.type).sort()).toEqual(["custom:mobile", "members"]);
    const customGroup = out.groups.find((g) => g.type === "custom:mobile")!;
    expect(customGroup.isSystem).toBe(false);
    expect(customGroup.ownerId).toBe("u-owner");

    // Both Roles appear (custom Role appears here too).
    expect(out.roles.map((r) => r.slug).sort()).toEqual(["member", "mobile-dev"]);

    // group-role facts preserve every (group, role) pair with its bundle.
    expect(out.groupRoleFacts).toHaveLength(2);
    const customFact = out.groupRoleFacts.find((f) => f.roleSlug === "mobile-dev")!;
    expect([...customFact.capabilitySlugs].sort()).toEqual(["control_browser", "use_remote_hosts"]);
  });

  test("Contributor + custom development Role union", () => {
    const rows: EffectiveAccessPathRow[] = [
      path(CONTRIBUTORS_GROUP, CONTRIBUTOR_ROLE, null), // contributor has no caps in this fixture
      path(CUSTOM_GROUP, CUSTOM_ROLE, "use_remote_hosts"),
    ];
    const out = buildEffectiveAccess(USER, rows, CATALOGUE);
    expect(out.highestRole).toBe("contributor");
    const remoteHosts = out.capabilities.find((c) => c.slug === "use_remote_hosts")!;
    expect(remoteHosts.granted).toBe(true);
    expect(remoteHosts.provenance[0]!.roleSlug).toBe("mobile-dev");
    // Contributor grants nothing in this fixture; use_workstation is not granted.
    expect(out.capabilities.find((c) => c.slug === "use_workstation")!.granted).toBe(false);
  });

  test("Multiple Roles on one Group preserve every provenance path", () => {
    // One custom Group carrying two Roles (member + custom) — both paths preserved.
    const rows: EffectiveAccessPathRow[] = [
      path(CUSTOM_GROUP, MEMBER_ROLE, "use_workstation"),
      path(CUSTOM_GROUP, CUSTOM_ROLE, "use_remote_hosts"),
    ];
    const out = buildEffectiveAccess(USER, rows, CATALOGUE);

    // The Group lists BOTH Roles (not collapsed to one).
    const g = out.groups.find((x) => x.id === CUSTOM_GROUP.id)!;
    expect([...g.roleSlugs].sort()).toEqual(["member", "mobile-dev"]);

    // group-role facts: two facts for the one Group.
    const factsForGroup = out.groupRoleFacts.filter((f) => f.groupId === CUSTOM_GROUP.id);
    expect(factsForGroup).toHaveLength(2);

    // use_remote_hosts provenance still resolves through the custom Role on this Group.
    const remoteHosts = out.capabilities.find((c) => c.slug === "use_remote_hosts")!;
    expect(remoteHosts.provenance).toHaveLength(1);
    expect(remoteHosts.provenance[0]!.roleSlug).toBe("mobile-dev");
    expect(remoteHosts.provenance[0]!.groupId).toBe(CUSTOM_GROUP.id);

    // use_workstation provenance resolves through the member Role on the SAME Group.
    const workstation = out.capabilities.find((c) => c.slug === "use_workstation")!;
    expect(workstation.provenance).toHaveLength(1);
    expect(workstation.provenance[0]!.roleSlug).toBe("member");
    expect(workstation.provenance[0]!.groupId).toBe(CUSTOM_GROUP.id);
  });

  test("A custom Role does not alter the highest canonical ladder Role", () => {
    // User is in members (member) + custom group with a custom role.
    const rows: EffectiveAccessPathRow[] = [
      path(MEMBERS_GROUP, MEMBER_ROLE, "use_workstation"),
      path(CUSTOM_GROUP, CUSTOM_ROLE, "use_remote_hosts"),
    ];
    const out = buildEffectiveAccess(USER, rows, CATALOGUE);
    expect(out.highestRole).toBe("member");
    // Adding a second custom role still keeps highestRole at member.
    const rows2: EffectiveAccessPathRow[] = [
      ...rows,
      path(CUSTOM_GROUP, { slug: "qa-role", label: "QA", isSystem: false }, "control_browser"),
    ];
    const out2 = buildEffectiveAccess(USER, rows2, CATALOGUE);
    expect(out2.highestRole).toBe("member");
  });

  test("Full catalogue is returned in stable order with granted/not-granted", () => {
    const rows: EffectiveAccessPathRow[] = [
      path(MEMBERS_GROUP, MEMBER_ROLE, "use_workstation"),
    ];
    const out = buildEffectiveAccess(USER, rows, CATALOGUE);
    // Stable order matches the canonical CAPABILITY_SLUGS ordering
    // (manage_members=0, use_project_execution=13, use_workstation=14,
    // use_remote_hosts=15, control_desktop=25, control_browser=26),
    // NOT the fixture's insertion order.
    expect(out.capabilities.map((c) => c.slug)).toEqual([
      "manage_members",
      "use_project_execution",
      "use_workstation",
      "use_remote_hosts",
      "control_desktop",
      "control_browser",
    ]);
    const granted = out.capabilities.filter((c) => c.granted).map((c) => c.slug);
    expect(granted).toEqual(["use_workstation"]);
    // Not-granted rows carry no provenance.
    const notGranted = out.capabilities.find((c) => c.slug === "control_desktop")!;
    expect(notGranted.granted).toBe(false);
    expect(notGranted.provenance).toEqual([]);
  });

  test("Unknown future capability slugs are tolerated and sorted after known ones", () => {
    const catalogueWithFuture: CatalogueCapabilityRow[] = [
      ...CATALOGUE,
      { slug: "future_cap", description: "Future", category: "tools" },
    ];
    const rows: EffectiveAccessPathRow[] = [
      path(CUSTOM_GROUP, CUSTOM_ROLE, "future_cap"),
    ];
    const out = buildEffectiveAccess(USER, rows, catalogueWithFuture);
    const future = out.capabilities.find((c) => c.slug === "future_cap")!;
    expect(future.granted).toBe(true);
    // Known caps come first; the unknown slug sorts after.
    expect(out.capabilities[out.capabilities.length - 1]!.slug).toBe("future_cap");
  });

  test("A user in multiple Groups: each Group's paths are preserved", () => {
    const rows: EffectiveAccessPathRow[] = [
      path(MEMBERS_GROUP, MEMBER_ROLE, "use_workstation"),
      path(CONTRIBUTORS_GROUP, CONTRIBUTOR_ROLE, null),
      path(CUSTOM_GROUP, CUSTOM_ROLE, "use_remote_hosts"),
    ];
    const out = buildEffectiveAccess(USER, rows, CATALOGUE);
    expect(out.groups.map((g) => g.type).sort()).toEqual(
      ["contributors", "custom:mobile", "members"].sort(),
    );
    // highestRole is member (rank 3) over contributor (rank 4).
    expect(out.highestRole).toBe("member");
  });
});
