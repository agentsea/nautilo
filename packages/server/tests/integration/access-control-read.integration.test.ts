/**
 * Stack 195 / W3.1.3 — integration coverage for the read-only access-control
 * endpoints: self effective-access, admin target-user effective-access, and
 * the admin catalogue. Exercises the live route + real `@nautilo/trust` query
 * path against the canonical seeded instance.
 */
import { describe, expect, test } from "bun:test";
import {
  actors,
  agents,
  capabilities,
  channelIdentities,
  eq,
  groupMembers,
  groupRoles,
  groups,
  profiles,
  roleCapabilities,
  roles,
  users,
} from "@nautilo/db";
import type { AppFixture } from "./helpers/app-fixture";
import { setupOwnerAppFixture, seatPeerUser } from "./helpers/app-fixture";
import { authedInject } from "./helpers/request-helpers";

async function cleanupPeer(fx: AppFixture, userId: string): Promise<void> {
  await fx.db.delete(profiles).where(eq(profiles.userId, userId));
  await fx.db.delete(channelIdentities).where(eq(channelIdentities.userId, userId));
  await fx.db.delete(groupMembers).where(eq(groupMembers.userId, userId));
  const peerAgentActors = await fx.db
    .select({ agentId: actors.agentId })
    .from(actors)
    .where(eq(actors.ownerId, userId));
  await fx.db.delete(actors).where(eq(actors.ownerId, userId));
  for (const a of peerAgentActors) {
    if (a.agentId) await fx.db.delete(agents).where(eq(agents.id, a.agentId));
  }
  await fx.db.delete(users).where(eq(users.id, userId));
}

interface EffectiveAccessBody {
  highestRole: string | null;
  user: { id: string; handle: string | null; displayName: string; server: string | null };
  capabilities: Array<{ slug: string; granted: boolean; provenance: unknown[] }>;
  groups: Array<{ id: string; type: string; isSystem: boolean; ownerId: string | null }>;
  roles: Array<{ slug: string; isSystem: boolean }>;
  groupRoleFacts: unknown[];
}

interface CatalogueBody {
  capabilities: Array<{ slug: string; description: string; category: string }>;
  roles: Array<{
    slug: string;
    isSystem: boolean;
    capabilitySlugs: string[];
    groupCount: number;
  }>;
  groups: Array<{
    id: string;
    type: string;
    isSystem: boolean;
    ownerId: string | null;
    roleSlugs: string[];
    memberCount: number;
  }>;
}

const UNKNOWN_USER_ID = "00000000-0000-0000-0000-000000000000";

describe("Stack 195 W3.1.3 — access-control read endpoints (raw API)", () => {
  test(
    "self + admin target + catalogue gates and shapes",
    async () => {
      const fx = await setupOwnerAppFixture({ suiteName: "s195w31" });
      const ownerBearer = await fx.mintOwnerBearer();

      const member = await seatPeerUser(fx.db, {
        suiteName: "s195w31",
        groupType: "members",
      });
      const admin = await seatPeerUser(fx.db, {
        suiteName: "s195w31",
        groupType: "admins",
      });

      try {
        // --- Self endpoint: authentication only ---

        // Unauthenticated → 401.
        const unauth = await fx.app.inject({
          method: "GET",
          url: "/api/access-control/me/effective-access",
        });
        expect(unauth.statusCode).toBe(401);

        // Owner self → 200, highestRole = owner.
        const ownerSelf = await authedInject(fx.app, {
          method: "GET",
          url: "/api/access-control/me/effective-access",
          bearer: ownerBearer,
        });
        expect(ownerSelf.statusCode).toBe(200);
        const ownerSelfBody = JSON.parse(ownerSelf.body) as EffectiveAccessBody;
        expect(ownerSelfBody.highestRole).toBe("owner");
        expect(ownerSelfBody.user.id).toBe(fx.ownerId);
        // Owner holds manage_members (canonical owner bundle).
        const ownerManageMembers = ownerSelfBody.capabilities.find(
          (c) => c.slug === "manage_members",
        )!;
        expect(ownerManageMembers.granted).toBe(true);
        // Full catalogue returned in stable order.
        expect(ownerSelfBody.capabilities.length).toBeGreaterThan(0);

        // Member self → 200, highestRole = member; custom Role never alters it.
        const memberSelf = await authedInject(fx.app, {
          method: "GET",
          url: "/api/access-control/me/effective-access",
          bearer: member.bearer,
        });
        expect(memberSelf.statusCode).toBe(200);
        const memberSelfBody = JSON.parse(memberSelf.body) as EffectiveAccessBody;
        expect(memberSelfBody.highestRole).toBe("member");
        // Member holds use_workstation_profiles (canonical member entitlement).
        const memberWsl = memberSelfBody.capabilities.find(
          (c) => c.slug === "use_workstation_profiles",
        )!;
        expect(memberWsl.granted).toBe(true);
        expect(
          memberWsl.provenance.some(
            (p) =>
              (p as { roleSlug: string; groupType: string }).roleSlug === "member" &&
              (p as { roleSlug: string; groupType: string }).groupType === "members",
          ),
        ).toBe(true);
        // Member does NOT hold manage_server_security (Owner-only nondelegable).
        expect(
          memberSelfBody.capabilities.find((c) => c.slug === "manage_server_security")!
            .granted,
        ).toBe(false);

        // --- Admin target endpoint: management-capability gate ---

        // Owner (has manage_members) reads member's effective access → 200.
        const ownerReadsMember = await authedInject(fx.app, {
          method: "GET",
          url: `/api/admin/access-control/users/${member.userId}/effective-access`,
          bearer: ownerBearer,
        });
        expect(ownerReadsMember.statusCode).toBe(200);
        const targetBody = JSON.parse(ownerReadsMember.body) as EffectiveAccessBody;
        expect(targetBody.user.id).toBe(member.userId);
        expect(targetBody.highestRole).toBe("member");

        // Admin (has manage_members via admin bundle) reads owner → 200.
        const adminReadsOwner = await authedInject(fx.app, {
          method: "GET",
          url: `/api/admin/access-control/users/${fx.ownerId}/effective-access`,
          bearer: admin.bearer,
        });
        expect(adminReadsOwner.statusCode).toBe(200);
        const adminReadsOwnerBody = JSON.parse(adminReadsOwner.body) as EffectiveAccessBody;
        expect(adminReadsOwnerBody.highestRole).toBe("owner");

        // Member (no management cap) reads owner → 403 (target data not disclosed).
        const memberReadsOwner = await authedInject(fx.app, {
          method: "GET",
          url: `/api/admin/access-control/users/${fx.ownerId}/effective-access`,
          bearer: member.bearer,
        });
        expect(memberReadsOwner.statusCode).toBe(403);

        // Unknown target → 404 (authorized caller).
        const ownerReadsUnknown = await authedInject(fx.app, {
          method: "GET",
          url: `/api/admin/access-control/users/${UNKNOWN_USER_ID}/effective-access`,
          bearer: ownerBearer,
        });
        expect(ownerReadsUnknown.statusCode).toBe(404);

        // Unauthenticated admin target → 401 (preceding 403).
        const unauthTarget = await fx.app.inject({
          method: "GET",
          url: `/api/admin/access-control/users/${member.userId}/effective-access`,
        });
        expect(unauthTarget.statusCode).toBe(401);

        // --- Catalogue endpoint: same management-capability gate ---

        const ownerCat = await authedInject(fx.app, {
          method: "GET",
          url: "/api/admin/access-control/catalogue",
          bearer: ownerBearer,
        });
        expect(ownerCat.statusCode).toBe(200);
        const catBody = JSON.parse(ownerCat.body) as CatalogueBody;
        // Server-truth capabilities in stable order.
        expect(catBody.capabilities.map((c) => c.slug)).toContain("use_workstation_profiles");
        // Canonical ladder roles present and marked system.
        const memberRole = catBody.roles.find((r) => r.slug === "member");
        expect(memberRole).toBeDefined();
        expect(memberRole!.isSystem).toBe(true);
        // Canonical 'members' group present, system, null owner.
        const membersGroup = catBody.groups.find((g) => g.type === "members");
        expect(membersGroup).toBeDefined();
        expect(membersGroup!.isSystem).toBe(true);
        expect(membersGroup!.ownerId).toBe(null);
        expect(membersGroup!.memberCount).toBeGreaterThanOrEqual(1);

        // Member (no management cap) → 403.
        const memberCat = await authedInject(fx.app, {
          method: "GET",
          url: "/api/admin/access-control/catalogue",
          bearer: member.bearer,
        });
        expect(memberCat.statusCode).toBe(403);

        // Unauthenticated catalogue → 401.
        const unauthCat = await fx.app.inject({
          method: "GET",
          url: "/api/admin/access-control/catalogue",
        });
        expect(unauthCat.statusCode).toBe(401);
      } finally {
        await cleanupPeer(fx, admin.userId);
        await cleanupPeer(fx, member.userId);
        await fx.cleanup();
      }
    },
    120000,
  );

  test(
    "human directory: coarse management-capability gate + minimal fields",
    async () => {
      const fx = await setupOwnerAppFixture({ suiteName: "s195w32" });
      const ownerBearer = await fx.mintOwnerBearer();

      // A non-manager (member of `members` — no management caps).
      const member = await seatPeerUser(fx.db, {
        suiteName: "s195w32",
        groupType: "members",
      });
      // Custom managers holding exactly ONE of the three management caps.
      // Canonical ladder roles grant all three (owner/admin) or none
      // (superuser and below), so a single-cap manager requires a custom
      // Role + custom Group seated via direct DB inserts — this is the
      // exact shape the W3.2 fix unblocks (a `manage_groups`-only or
      // `manage_roles`-only custom manager).
      const groupsMgr = await seatCustomManager(fx, {
        suiteName: "s195w32",
        capabilitySlug: "manage_groups",
        roleSlug: "s195w32-mg-groups",
        groupType: "s195w32-mg-groups",
      });
      const rolesMgr = await seatCustomManager(fx, {
        suiteName: "s195w32",
        capabilitySlug: "manage_roles",
        roleSlug: "s195w32-mg-roles",
        groupType: "s195w32-mg-roles",
      });

      try {
        // --- 200: each individual management capability can access ---

        // Owner holds manage_members (among all three) → 200.
        const ownerList = await authedInject(fx.app, {
          method: "GET",
          url: "/api/admin/access-control/users",
          bearer: ownerBearer,
        });
        expect(ownerList.statusCode).toBe(200);
        const ownerBody = JSON.parse(ownerList.body) as Array<{
          userId: string;
          displayName: string;
          handle: string | null;
        }>;

        // Minimal fields only — never email, external IDs, capability
        // bundles, disabled/offboard metadata, tokens, or secrets.
        const ownerRow = ownerBody.find((r) => r.userId === fx.ownerId);
        expect(ownerRow).toBeDefined();
        expect(Object.keys(ownerRow!).sort()).toEqual(
          ["displayName", "handle", "userId"].sort(),
        );
        expect(ownerRow!.displayName).toBe("s195w32-owner");
        expect(typeof ownerRow!.handle).toBe("string");

        // Stable sort: rows are ordered by displayName then userId, so the
        // sequence is deterministic across calls.
        const secondOwnerList = await authedInject(fx.app, {
          method: "GET",
          url: "/api/admin/access-control/users",
          bearer: ownerBearer,
        });
        const secondBody = JSON.parse(secondOwnerList.body) as Array<{
          userId: string;
        }>;
        expect(secondBody.map((r) => r.userId)).toEqual(
          ownerBody.map((r) => r.userId),
        );

        // manage_groups-only custom manager → 200 (the bug this fixes).
        const groupsList = await authedInject(fx.app, {
          method: "GET",
          url: "/api/admin/access-control/users",
          bearer: groupsMgr.bearer,
        });
        expect(groupsList.statusCode).toBe(200);

        // manage_roles-only custom manager → 200.
        const rolesList = await authedInject(fx.app, {
          method: "GET",
          url: "/api/admin/access-control/users",
          bearer: rolesMgr.bearer,
        });
        expect(rolesList.statusCode).toBe(200);

        // --- 403: a non-manager is denied ---

        const memberList = await authedInject(fx.app, {
          method: "GET",
          url: "/api/admin/access-control/users",
          bearer: member.bearer,
        });
        expect(memberList.statusCode).toBe(403);

        // --- 401: anonymous is denied ---

        const unauthList = await fx.app.inject({
          method: "GET",
          url: "/api/admin/access-control/users",
        });
        expect(unauthList.statusCode).toBe(401);
      } finally {
        await cleanupCustomManager(fx, groupsMgr);
        await cleanupCustomManager(fx, rolesMgr);
        await cleanupPeer(fx, member.userId);
        await fx.cleanup();
      }
    },
    120000,
  );
});

/**
 * Seat a peer user who holds EXACTLY one management capability, via a
 * custom (non-system) Role + custom Group. The peer is first seated into
 * the canonical `members` group (no management caps) by `seatPeerUser`,
 * then additionally added to the custom group whose custom role bundles
 * only `capabilitySlug`. The effective management caps are therefore the
 * single requested one — the shape the W3.2 endpoint must unblock.
 */
async function seatCustomManager(
  fx: AppFixture,
  opts: {
    suiteName: string;
    capabilitySlug: "manage_groups" | "manage_roles" | "manage_members";
    roleSlug: string;
    groupType: string;
  },
): Promise<{
  userId: string;
  actorId: string;
  bearer: string;
  roleId: string;
  groupId: string;
}> {
  const peer = await seatPeerUser(fx.db, {
    suiteName: opts.suiteName,
    groupType: "members",
  });

  const [cap] = await fx.db
    .select({ id: capabilities.id })
    .from(capabilities)
    .where(eq(capabilities.slug, opts.capabilitySlug))
    .limit(1);
  if (!cap) throw new Error(`seatCustomManager: capability ${opts.capabilitySlug} missing`);

  const [role] = await fx.db
    .insert(roles)
    .values({
      slug: opts.roleSlug,
      label: opts.roleSlug,
      isSystem: false,
    })
    .returning({ id: roles.id });
  if (!role) throw new Error("seatCustomManager: role insert failed");
  await fx.db
    .insert(roleCapabilities)
    .values({ roleId: role.id, capabilityId: cap.id })
    .onConflictDoNothing();

  const [group] = await fx.db
    .insert(groups)
    .values({
      type: opts.groupType,
      label: opts.groupType,
      isSystem: false,
      ownerId: fx.ownerId,
      trustPreset: "personal",
    })
    .returning({ id: groups.id });
  if (!group) throw new Error("seatCustomManager: group insert failed");
  await fx.db
    .insert(groupRoles)
    .values({ groupId: group.id, roleId: role.id })
    .onConflictDoNothing();
  await fx.db
    .insert(groupMembers)
    .values({
      groupId: group.id,
      userId: peer.userId,
      grantedBy: peer.actorId,
    })
    .onConflictDoNothing({ target: [groupMembers.groupId, groupMembers.userId] });

  return {
    userId: peer.userId,
    actorId: peer.actorId,
    bearer: peer.bearer,
    roleId: role.id,
    groupId: group.id,
  };
}

/**
 * Tear down a custom manager: drop the custom group + custom role (and
 * their junction rows via cascade), then the peer user via `cleanupPeer`.
 */
async function cleanupCustomManager(
  fx: AppFixture,
  mgr: {
    userId: string;
    roleId: string;
    groupId: string;
  },
): Promise<void> {
  await fx.db.delete(groupMembers).where(eq(groupMembers.groupId, mgr.groupId));
  await fx.db.delete(groupRoles).where(eq(groupRoles.groupId, mgr.groupId));
  await fx.db.delete(groups).where(eq(groups.id, mgr.groupId));
  await fx.db
    .delete(roleCapabilities)
    .where(eq(roleCapabilities.roleId, mgr.roleId));
  await fx.db.delete(roles).where(eq(roles.id, mgr.roleId));
  await cleanupPeer(fx, mgr.userId);
}
