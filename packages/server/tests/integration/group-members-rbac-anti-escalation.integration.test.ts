/**
 * Stack 195 / W3.0.2 — integration coverage for the shared anti-escalation
 * resolver routed through the existing
 * `PUT/DELETE /api/groups/:id/members/:userId` writes.
 *
 * Acceptance map (wave-3-stack-195-tasks.md W3.0.2c–e):
 *   - A direct raw-API Admin → Owners add is rejected (403 authorization_denied,
 *     reason insufficient_authority, missing the Owner-only caps).
 *   - A direct raw-API Admin removing an Owner is rejected even when
 *     multiple Owners remain (reduction is not an exemption).
 *   - An Owner retains expected non-owner membership operations (add/remove
 *     on the admins Group).
 *   - A non-manager (Member) is rejected with reason missing_manage_members.
 *
 * These exercise the live route + real `@nautilo/trust` query path; the
 * pure policy matrix is covered in
 * `packages/trust/tests/unit/rbac-anti-escalation.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import Fastify from "fastify";
import type { ChallengeProvider, RbacProjection } from "@nautilo/trust";
import {
  actors,
  agents,
  and,
  capabilities,
  channelIdentities,
  createDirectDb,
  ensureDatabase,
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
import { groupMembersRoutes } from "../../src/routes/group-members";
import { UncontainedHostCommandsController } from "../../src/routes/security";

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

async function findGroupId(fx: AppFixture, type: string): Promise<string> {
  const [row] = await fx.db
    .select({ id: groups.id })
    .from(groups)
    .where(eq(groups.type, type))
    .limit(1);
  if (!row) throw new Error(`canonical ${type} group missing`);
  return row.id;
}

async function populatedCanonicalOwnersSkipReason(): Promise<string | null> {
  await ensureDatabase();
  const db = createDirectDb(1);
  try {
    const [ownersGroup] = await db
      .select({ id: groups.id })
      .from(groups)
      .where(eq(groups.type, "owners"))
      .limit(1);
    if (!ownersGroup) return null;
    const [membership] = await db
      .select({ userId: groupMembers.userId })
      .from(groupMembers)
      .where(eq(groupMembers.groupId, ownersGroup.id))
      .limit(1);
    return membership
      ? "canonical Owners group already has members; sole-Owner mutation coverage requires an unpopulated integration database"
      : null;
  } finally {
    await db.end();
  }
}

const soleOwnerSkipReason = await populatedCanonicalOwnersSkipReason();
if (soleOwnerSkipReason) {
  console.warn(`Skipping sole-Owner group-members integration test: ${soleOwnerSkipReason}`);
}

// `groups` is imported via the db barrel above for the lookup helper.

describe("D538 direct group-members revocation seam", () => {
  test("successful relevant removal aborts the real controller activation; denied and failed removals do not", async () => {
    const fx = await setupOwnerAppFixture({ suiteName: "d538directrev" });
    const target = await seatPeerUser(fx.db, {
      suiteName: "d538directrev",
      groupType: "members",
    });
    const denied = await seatPeerUser(fx.db, {
      suiteName: "d538directrevdeny",
      groupType: "members",
    });
    const adminsGroupId = await findGroupId(fx, "admins");
    await fx.db
      .insert(groupMembers)
      .values({
        groupId: adminsGroupId,
        userId: target.userId,
        grantedBy: fx.ownerActorId,
      })
      .onConflictDoNothing({ target: [groupMembers.groupId, groupMembers.userId] });

    const routeApp = Fastify({ logger: false });
    routeApp.decorateRequest("sessionUserId", null);
    routeApp.decorateRequest("sessionActorId", null);
    let principal = { userId: fx.ownerId, actorId: fx.ownerActorId };
    routeApp.addHook("preHandler", (request, _reply, done) => {
      request.sessionUserId = principal.userId;
      request.sessionActorId = principal.actorId;
      done();
    });
    const binding = {
      userId: target.userId,
      serverBindingId: "d538-db-server",
      relayId: "d538-db-relay",
      desktopSessionId: "d538-db-desktop",
      pairingGeneration: "d538-db-pairing",
      capabilityRevision: 1,
    };
    const projection: RbacProjection = {
      highestRole: "admin",
      capabilitySlugs: [],
      groupChips: [{
        id: "d538-db-grant",
        type: "uncontained_host_commands_grantees",
        label: "Uncontained host commands grantees",
        roleSlug: "uncontained_host_commands_grantee",
      }, {
        id: adminsGroupId,
        type: "admins",
        label: "Admins",
        roleSlug: "admin",
      }],
    };
    const pinProvider: ChallengeProvider = {
      verifyProof: (userId, proof) =>
        Promise.resolve(userId === target.userId && proof === "246810"),
      isEnrolled: (userId) => Promise.resolve(userId === target.userId),
    };
    const controller = new UncontainedHostCommandsController({
      pinProvider,
      getAllowUncontainedHostCommands: () => true,
      getLiveRelayBinding: (input) =>
        input.userId === binding.userId &&
        input.relayId === binding.relayId &&
        input.desktopSessionId === binding.desktopSessionId
          ? binding
          : null,
      getRbac: () => Promise.resolve(projection),
      auditEvent: () => Promise.resolve(),
    });
    const activation = await controller.activate({
      userId: target.userId,
      actorId: target.actorId,
      pin: "246810",
      relayId: binding.relayId,
      desktopSessionId: binding.desktopSessionId,
      ip: "127.0.0.1",
      userAgent: "d538-db-test",
    });
    expect(activation.ok).toBe(true);
    const admission = await controller.resolveDispatch({
      userId: target.userId,
      actorId: target.actorId,
      relayId: binding.relayId,
      desktopSessionId: binding.desktopSessionId,
      pairingGeneration: binding.pairingGeneration,
      toolCallId: "d538-db-call",
    });
    if (!admission.admitted) throw new Error("expected real controller admission");
    const prepared: Array<{ userId: string; groupId: string; actorId: string }> = [];
    groupMembersRoutes(routeApp, {
      prepareMembershipRemoval: (input) => {
        prepared.push(input);
        return controller.prepareMembershipRemoval(input);
      },
    });
    await routeApp.ready();

    try {
      principal = { userId: denied.userId, actorId: denied.actorId };
      const deniedRemoval = await routeApp.inject({
        method: "DELETE",
        url: `/api/groups/${adminsGroupId}/members/${target.userId}`,
      });
      expect(deniedRemoval.statusCode).toBe(403);
      expect(admission.activationSignal.aborted).toBe(false);

      principal = { userId: fx.ownerId, actorId: fx.ownerActorId };
      const missingRemoval = await routeApp.inject({
        method: "DELETE",
        url: `/api/groups/${crypto.randomUUID()}/members/${target.userId}`,
      });
      expect(missingRemoval.statusCode).toBe(404);
      expect(admission.activationSignal.aborted).toBe(false);

      const applied = await routeApp.inject({
        method: "DELETE",
        url: `/api/groups/${adminsGroupId}/members/${target.userId}`,
      });
      expect(applied.statusCode).toBe(200);
      expect(applied.json()).toMatchObject({ ok: true, auditRecorded: true });
      expect(prepared.at(-1)).toEqual({
        userId: target.userId,
        groupId: adminsGroupId,
        actorId: fx.ownerActorId,
      });
      expect(admission.activationSignal.aborted).toBe(true);
    } finally {
      await routeApp.close();
      await cleanupPeer(fx, target.userId);
      await cleanupPeer(fx, denied.userId);
      await fx.cleanup();
    }
  }, 120000);
});

describe("Stack 195 W3.0.2 — group-members RBAC anti-escalation (raw API)", () => {
  test(
    "Admin → Owners add/remove is rejected; Owner retains non-owner ops; Member rejected",
    async () => {
      const fx = await setupOwnerAppFixture({ suiteName: "s195w302" });
      const ownerBearer = await fx.mintOwnerBearer();
      const ownersGroupId = await findGroupId(fx, "owners");
      const adminsGroupId = await findGroupId(fx, "admins");

      const admin = await seatPeerUser(fx.db, {
        suiteName: "s195w302",
        groupType: "admins",
      });
      const member = await seatPeerUser(fx.db, {
        suiteName: "s195w302",
        groupType: "members",
      });
      // A second Owner target so the "remove an Owner" case has multiple
      // Owners remaining (the last-Owner rail must NOT be the thing that
      // stops the Admin — bundle authority must).
      const secondOwner = await seatPeerUser(fx.db, {
        suiteName: "s195w302",
        groupType: "members",
      });

      try {
        // Owner promotes `secondOwner` into the owners Group. The Owner
        // holds the full bundle, so this is authorized and now the owners
        // Group has the fixture Owner + secondOwner (≥2 Owners).
        const promote = await authedInject(fx.app, {
          method: "PUT",
          url: `/api/groups/${ownersGroupId}/members/${secondOwner.userId}`,
          bearer: ownerBearer,
        });
        expect(promote.statusCode).toBe(200);

        // W3.0.2c — direct raw-API Admin → Owners add is rejected.
        const adminAddOwner = await authedInject(fx.app, {
          method: "PUT",
          url: `/api/groups/${ownersGroupId}/members/${member.userId}`,
          bearer: admin.bearer,
        });
        expect(adminAddOwner.statusCode).toBe(403);
        const addBody = JSON.parse(adminAddOwner.body) as {
          code: string;
          reason: string;
          missing: string[];
        };
        expect(addBody.code).toBe("authorization_denied");
        expect(addBody.reason).toBe("insufficient_authority");
        expect(addBody.missing).toContain("manage_server_settings");
        expect(addBody.missing).toContain("manage_server_security");

        // W3.0.2d — Admin removing an Owner is rejected even though
        // multiple Owners remain (reduction is not an exemption).
        const adminRemoveOwner = await authedInject(fx.app, {
          method: "DELETE",
          url: `/api/groups/${ownersGroupId}/members/${secondOwner.userId}`,
          bearer: admin.bearer,
        });
        expect(adminRemoveOwner.statusCode).toBe(403);
        const removeBody = JSON.parse(adminRemoveOwner.body) as {
          code: string;
          reason: string;
          missing: string[];
        };
        expect(removeBody.code).toBe("authorization_denied");
        expect(removeBody.reason).toBe("insufficient_authority");
        expect(removeBody.missing).toContain("manage_server_security");
        // The Owner was NOT removed.
        const stillOwner = await fx.db
          .select({ userId: groupMembers.userId })
          .from(groupMembers)
          .where(
            and(
              eq(groupMembers.groupId, ownersGroupId),
              eq(groupMembers.userId, secondOwner.userId),
            ),
          )
          .limit(1);
        expect(stillOwner.length).toBe(1);

        // Owner retains non-owner membership operations on the admins
        // Group (add then remove the member peer).
        const ownerAddAdmin = await authedInject(fx.app, {
          method: "PUT",
          url: `/api/groups/${adminsGroupId}/members/${member.userId}`,
          bearer: ownerBearer,
        });
        expect(ownerAddAdmin.statusCode).toBe(200);
        const ownerRemoveAdmin = await authedInject(fx.app, {
          method: "DELETE",
          url: `/api/groups/${adminsGroupId}/members/${member.userId}`,
          bearer: ownerBearer,
        });
        expect(ownerRemoveAdmin.statusCode).toBe(200);

        // An Admin also retains non-owner ops on the admins Group (the
        // admins bundle is a subset of the Admin's caps). Admin adds the
        // member peer to admins, then removes them.
        const adminAddAdmin = await authedInject(fx.app, {
          method: "PUT",
          url: `/api/groups/${adminsGroupId}/members/${member.userId}`,
          bearer: admin.bearer,
        });
        expect(adminAddAdmin.statusCode).toBe(200);
        const adminRemoveAdmin = await authedInject(fx.app, {
          method: "DELETE",
          url: `/api/groups/${adminsGroupId}/members/${member.userId}`,
          bearer: admin.bearer,
        });
        expect(adminRemoveAdmin.statusCode).toBe(200);

        // A non-manager (Member) is rejected with missing_manage_members
        // when attempting any membership write — the management gate fires.
        const memberAdd = await authedInject(fx.app, {
          method: "PUT",
          url: `/api/groups/${adminsGroupId}/members/${admin.userId}`,
          bearer: member.bearer,
        });
        expect(memberAdd.statusCode).toBe(403);
        const memberBody = JSON.parse(memberAdd.body) as {
          code: string;
          reason: string;
        };
        expect(memberBody.code).toBe("authorization_denied");
        expect(memberBody.reason).toBe("missing_manage_members");

        // 404 group_not_found still precedes the resolver for a bogus group.
        const bogusGroup = await authedInject(fx.app, {
          method: "PUT",
          url: `/api/groups/00000000-0000-0000-0000-000000000000/members/${member.userId}`,
          bearer: ownerBearer,
        });
        expect(bogusGroup.statusCode).toBe(404);
      } finally {
        // Remove secondOwner from the owners Group first so the canonical
        // owners Group is left with only the fixture Owner (avoid
        // perturbing the instance's owners set beyond the fixture owner).
        await fx.db
          .delete(groupMembers)
          .where(
            and(
              eq(groupMembers.groupId, ownersGroupId),
              eq(groupMembers.userId, secondOwner.userId),
            ),
          );
        await cleanupPeer(fx, admin.userId);
        await cleanupPeer(fx, member.userId);
        await cleanupPeer(fx, secondOwner.userId);
        await fx.cleanup();
      }
    },
    120000,
  );
});

describe("Stack 195 follow-up — group-members read authz + owner invariant + audit precision", () => {
  test(
    "GET /api/groups/:id/members requires manage_members (401/403/404 ordering, no roster leak)",
    async () => {
      const fx = await setupOwnerAppFixture({ suiteName: "s195get" });
      const ownerBearer = await fx.mintOwnerBearer();
      const ownersGroupId = await findGroupId(fx, "owners");
      const adminsGroupId = await findGroupId(fx, "admins");
      const member = await seatPeerUser(fx.db, {
        suiteName: "s195get",
        groupType: "members",
      });

      try {
        // Anonymous → 401 (before any group existence check).
        const anon = await fx.app.inject({
          method: "GET",
          url: `/api/groups/${ownersGroupId}/members`,
        });
        expect(anon.statusCode).toBe(401);

        // A non-manager (Member, no manage_members) → 403, and a bogus group
        // id ALSO returns 403 (not 404) so a non-manager cannot learn whether
        // a Group exists by probing — the roster never leaks.
        const memberGetReal = await authedInject(fx.app, {
          method: "GET",
          url: `/api/groups/${ownersGroupId}/members`,
          bearer: member.bearer,
        });
        expect(memberGetReal.statusCode).toBe(403);
        const memberGetBogus = await authedInject(fx.app, {
          method: "GET",
          url: `/api/groups/00000000-0000-0000-0000-000000000000/members`,
          bearer: member.bearer,
        });
        expect(memberGetBogus.statusCode).toBe(403);

        // An Owner (holds manage_members) → 200 roster for a real group, and
        // 404 for a bogus group (existence is only revealed to managers).
        const ownerGetReal = await authedInject(fx.app, {
          method: "GET",
          url: `/api/groups/${adminsGroupId}/members`,
          bearer: ownerBearer,
        });
        expect(ownerGetReal.statusCode).toBe(200);
        const body = JSON.parse(ownerGetReal.body) as { members: unknown[] };
        expect(Array.isArray(body.members)).toBe(true);
        const ownerGetBogus = await authedInject(fx.app, {
          method: "GET",
          url: `/api/groups/00000000-0000-0000-0000-000000000000/members`,
          bearer: ownerBearer,
        });
        expect(ownerGetBogus.statusCode).toBe(404);
      } finally {
        await cleanupPeer(fx, member.userId);
        await fx.cleanup();
      }
    },
    120000,
  );

  test.skipIf(soleOwnerSkipReason !== null)(
    "sole-Owner removal is rejected even with ?bypass=true; multiple-Owner removal succeeds; auditRecorded is surfaced",
    async () => {
      const fx = await setupOwnerAppFixture({ suiteName: "s195own" });
      const ownerBearer = await fx.mintOwnerBearer();
      const ownersGroupId = await findGroupId(fx, "owners");
      const adminsGroupId = await findGroupId(fx, "admins");
      const member = await seatPeerUser(fx.db, {
        suiteName: "s195own",
        groupType: "members",
      });
      // A second Owner so the "multiple Owners" removal path is exercisable.
      const secondOwner = await seatPeerUser(fx.db, {
        suiteName: "s195own",
        groupType: "members",
      });

      try {
        // Owner promotes secondOwner into the owners Group (authorized).
        const promote = await authedInject(fx.app, {
          method: "PUT",
          url: `/api/groups/${ownersGroupId}/members/${secondOwner.userId}`,
          bearer: ownerBearer,
        });
        expect(promote.statusCode).toBe(200);
        const promoteBody = JSON.parse(promote.body) as { ok: boolean; auditRecorded?: boolean };
        expect(promoteBody.ok).toBe(true);
        // Audit visibility — the audit-append outcome is surfaced.
        expect(promoteBody.auditRecorded).toBe(true);

        // Sole-Owner removal is rejected even with bypass=true. The fixture
        // owner is one of two Owners here, so removing the owner does NOT
        // hit the sole-Owner rail. To exercise the sole-Owner rail directly,
        // remove secondOwner first (back to a sole Owner), then attempt to
        // remove the sole Owner with bypass=true.
        const removeSecond = await authedInject(fx.app, {
          method: "DELETE",
          url: `/api/groups/${ownersGroupId}/members/${secondOwner.userId}`,
          bearer: ownerBearer,
        });
        expect(removeSecond.statusCode).toBe(200);
        const removeSecondBody = JSON.parse(removeSecond.body) as {
          ok: boolean;
          auditRecorded?: boolean;
        };
        expect(removeSecondBody.ok).toBe(true);
        expect(removeSecondBody.auditRecorded).toBe(true);

        // Now the fixture owner is the sole Owner. Attempting to remove them
        // with bypass=true is STILL rejected (409 last_owner) — the bypass
        // is no longer honored for the sole-Owner case.
        const removeSole = await authedInject(fx.app, {
          method: "DELETE",
          url: `/api/groups/${ownersGroupId}/members/${fx.ownerId}?bypass=true`,
          bearer: ownerBearer,
        });
        expect(removeSole.statusCode).toBe(409);
        const removeSoleBody = JSON.parse(removeSole.body) as { code: string };
        expect(removeSoleBody.code).toBe("last_owner");
        // The sole Owner was NOT removed.
        const stillOwner = await fx.db
          .select({ userId: groupMembers.userId })
          .from(groupMembers)
          .where(
            and(
              eq(groupMembers.groupId, ownersGroupId),
              eq(groupMembers.userId, fx.ownerId),
            ),
          )
          .limit(1);
        expect(stillOwner.length).toBe(1);

        // Multiple-Owners removal path: re-promote secondOwner, then remove
        // them again (a non-sole Owner removal succeeds).
        await authedInject(fx.app, {
          method: "PUT",
          url: `/api/groups/${ownersGroupId}/members/${secondOwner.userId}`,
          bearer: ownerBearer,
        });
        const removeNonSole = await authedInject(fx.app, {
          method: "DELETE",
          url: `/api/groups/${ownersGroupId}/members/${secondOwner.userId}`,
          bearer: ownerBearer,
        });
        expect(removeNonSole.statusCode).toBe(200);

        // A non-owner membership op (Owner removing the member from admins
        // after seating them) surfaces auditRecorded on the remove too.
        const seatAdmin = await authedInject(fx.app, {
          method: "PUT",
          url: `/api/groups/${adminsGroupId}/members/${member.userId}`,
          bearer: ownerBearer,
        });
        expect(seatAdmin.statusCode).toBe(200);
        const removeAdmin = await authedInject(fx.app, {
          method: "DELETE",
          url: `/api/groups/${adminsGroupId}/members/${member.userId}`,
          bearer: ownerBearer,
        });
        expect(removeAdmin.statusCode).toBe(200);
        const removeAdminBody = JSON.parse(removeAdmin.body) as {
          ok: boolean;
          auditRecorded?: boolean;
        };
        expect(removeAdminBody.ok).toBe(true);
        expect(removeAdminBody.auditRecorded).toBe(true);
      } finally {
        // Ensure secondOwner is removed from the owners Group before cleanup
        // so the canonical owners set is left with only the fixture owner.
        await fx.db
          .delete(groupMembers)
          .where(
            and(
              eq(groupMembers.groupId, ownersGroupId),
              eq(groupMembers.userId, secondOwner.userId),
            ),
          );
        await cleanupPeer(fx, member.userId);
        await cleanupPeer(fx, secondOwner.userId);
        await fx.cleanup();
      }
    },
    120000,
  );
});

describe("Stack 195 follow-up — GET /api/groups management-cap gating (raw API)", () => {
  /**
   * Seat a peer into a fresh CUSTOM Group carrying a fresh custom Role that
   * grants exactly one Capability (`manage_groups` here, NOT `manage_members`)
   * so the "custom manager allowed on a non-`manage_members` cap" path is
   * exercisable. Mirrors `seatCustomManager` in
   * `access-control-read.integration.test.ts`.
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
      .values({ slug: opts.roleSlug, label: opts.roleSlug, isSystem: false })
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
      .values({ groupId: group.id, userId: peer.userId, grantedBy: peer.actorId })
      .onConflictDoNothing({ target: [groupMembers.groupId, groupMembers.userId] });

    return {
      userId: peer.userId,
      actorId: peer.actorId,
      bearer: peer.bearer,
      roleId: role.id,
      groupId: group.id,
    };
  }

  async function cleanupCustomManager(
    fx: AppFixture,
    mgr: { userId: string; roleId: string; groupId: string },
  ): Promise<void> {
    await fx.db.delete(groupMembers).where(eq(groupMembers.groupId, mgr.groupId));
    await fx.db.delete(groupRoles).where(eq(groupRoles.groupId, mgr.groupId));
    await fx.db.delete(groups).where(eq(groups.id, mgr.groupId));
    await fx.db.delete(roleCapabilities).where(eq(roleCapabilities.roleId, mgr.roleId));
    await fx.db.delete(roles).where(eq(roles.id, mgr.roleId));
    await cleanupPeer(fx, mgr.userId);
  }

  test(
    "GET /api/groups requires manage_members|manage_groups|manage_roles (401/403 ordering)",
    async () => {
      const fx = await setupOwnerAppFixture({ suiteName: "s195grp" });
      const ownerBearer = await fx.mintOwnerBearer();

      const admin = await seatPeerUser(fx.db, {
        suiteName: "s195grp",
        groupType: "admins",
      });
      const member = await seatPeerUser(fx.db, {
        suiteName: "s195grp",
        groupType: "members",
      });
      // Custom manager holding ONLY manage_groups (not manage_members).
      const customMgr = await seatCustomManager(fx, {
        suiteName: "s195grp",
        capabilitySlug: "manage_groups",
        roleSlug: "s195grp-grp-only",
        groupType: "s195grp-custom-grp",
      });

      try {
        // Anonymous → 401 (before any cap check; no Group-set leak).
        const anon = await fx.app.inject({ method: "GET", url: "/api/groups" });
        expect(anon.statusCode).toBe(401);

        // An ordinary member (no management cap) → 403. The Group catalogue
        // (IDs / types / labels / role slugs) is NOT returned.
        const memberGet = await authedInject(fx.app, {
          method: "GET",
          url: "/api/groups",
          bearer: member.bearer,
        });
        expect(memberGet.statusCode).toBe(403);
        const memberBody = JSON.parse(memberGet.body) as { error: string };
        expect(memberBody.error).toBe("Forbidden");

        // An Owner (holds manage_members) → 200 with the Group catalogue.
        const ownerGet = await authedInject(fx.app, {
          method: "GET",
          url: "/api/groups",
          bearer: ownerBearer,
        });
        expect(ownerGet.statusCode).toBe(200);
        const ownerBody = JSON.parse(ownerGet.body) as {
          groups: Array<{ id: string; type: string; roleSlugs: string[] }>;
        };
        expect(Array.isArray(ownerBody.groups)).toBe(true);
        expect(ownerBody.groups.length).toBeGreaterThan(0);

        // An Admin (holds manage_members) → 200 likewise.
        const adminGet = await authedInject(fx.app, {
          method: "GET",
          url: "/api/groups",
          bearer: admin.bearer,
        });
        expect(adminGet.statusCode).toBe(200);

        // A custom manager holding ONLY manage_groups (not manage_members)
        // → 200 (any one of the three RBAC management caps suffices).
        const customMgrGet = await authedInject(fx.app, {
          method: "GET",
          url: "/api/groups",
          bearer: customMgr.bearer,
        });
        expect(customMgrGet.statusCode).toBe(200);
        const customMgrBody = JSON.parse(customMgrGet.body) as {
          groups: Array<{ id: string; type: string }>;
        };
        // The catalogue is Group IDs/types/labels/role slugs only — no
        // member roster rows are returned on this read.
        for (const g of customMgrBody.groups) {
          expect(g).not.toHaveProperty("members");
        }
      } finally {
        await cleanupCustomManager(fx, customMgr);
        await cleanupPeer(fx, admin.userId);
        await cleanupPeer(fx, member.userId);
        await fx.cleanup();
      }
    },
    120000,
  );
});
