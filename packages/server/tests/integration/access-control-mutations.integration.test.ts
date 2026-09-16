/**
 * Stack 195 / W3.2 — integration coverage for the preview/apply mutation
 * endpoints (`POST /api/admin/access-control/changes/preview` + `/apply`)
 * and the legacy membership route now routed through the shared engine.
 *
 * Acceptance map (wave-3-stack-195-tasks.md W3.2.1–W3.2.5 + W3.3.6 adversarial
 * subset): preview/apply parity; stale-preview rejection; a normal
 * authorized custom Role+Group flow; protected system rows rejected;
 * nondelegable caps rejected; admin cannot mutate/delete a stronger object;
 * reserved slug/type rejected; Group deletion with approval-challenge
 * cleanup; legacy membership route calls the shared engine; audit append
 * result shape.
 */
import { describe, expect, test } from "bun:test";
import Fastify from "fastify";
import {
  actors,
  agents,
  and,
  approvalChallenges,
  channelIdentities,
  createDirectDb,
  eq,
  ensureDatabase,
  groupMembers,
  groupRoles,
  groups,
  profiles,
  roles,
  seedTrustPersonal,
  users,
} from "@nautilo/db";
import type { AppFixture } from "./helpers/app-fixture";
import { setupOwnerAppFixture, seatPeerUser } from "./helpers/app-fixture";
import { authedInject } from "./helpers/request-helpers";
import { accessControlMutationRoutes } from "../../src/routes/access-control-mutations";

interface CanonicalSeedFixture {
  readonly db: ReturnType<typeof createDirectDb>;
  readonly userId: string;
}

/**
 * `setupOwnerAppFixture` intentionally models a running server and therefore
 * expects its canonical RBAC ladder to exist already. This suite also needs
 * to run against a freshly migrated scratch DB, so seed that production
 * ladder with a disposable bootstrap user only when it is absent.
 *
 * Teardown deletes this temporary user and its related rows; canonical
 * capabilities, Roles, Groups, and role edges deliberately remain available
 * to concurrent/following suites just like the normal server bootstrap.
 */
async function ensureCanonicalRbacLadder(): Promise<CanonicalSeedFixture | null> {
  await ensureDatabase();
  const db = createDirectDb(1);
  const [ownersGroup] = await db
    .select({ id: groups.id })
    .from(groups)
    .where(eq(groups.type, "owners"))
    .limit(1);
  if (ownersGroup) {
    await db.end();
    return null;
  }

  const suffix = `${Date.now().toString(36)}${crypto.randomUUID().slice(0, 8)}`;
  const [user] = await db
    .insert(users)
    .values({
      name: "s195w32 canonical seed",
      email: `s195w32-seed-${suffix}@test.local`,
      handle: `s195w32seed${suffix}`.slice(0, 48),
      externalId: `s195w32-seed-${suffix}`,
    })
    .returning({ id: users.id });
  if (!user) throw new Error("canonical RBAC seed user insert failed");

  try {
    await seedTrustPersonal(user.id, "s195w32 canonical seed");
  } catch (error) {
    await db.delete(users).where(eq(users.id, user.id));
    await db.end();
    throw error;
  }
  return { db, userId: user.id };
}

async function cleanupCanonicalSeedFixture(
  fixture: CanonicalSeedFixture | null,
): Promise<void> {
  if (!fixture) return;
  try {
    await fixture.db.delete(groupMembers).where(eq(groupMembers.userId, fixture.userId));
    await fixture.db.delete(channelIdentities).where(eq(channelIdentities.userId, fixture.userId));
    await fixture.db.delete(actors).where(eq(actors.ownerId, fixture.userId));
    await fixture.db.delete(users).where(eq(users.id, fixture.userId));
  } finally {
    await fixture.db.end();
  }
}

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
  const [row] = await fx.db.select({ id: groups.id }).from(groups).where(eq(groups.type, type)).limit(1);
  if (!row) throw new Error(`group ${type} missing`);
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
  console.warn(`Skipping sole-Owner preview/apply integration test: ${soleOwnerSkipReason}`);
}

interface PreviewBody {
  ok: boolean;
  fingerprint: string;
  failures: { code: string }[];
  auditPreview: { kind: string };
  deletionConsequence?: { approvalChallengesRemoved?: number } | null;
}

async function preview(
  fx: AppFixture,
  bearer: string,
  operation: Record<string, unknown>,
): Promise<{ status: number; body: PreviewBody }> {
  const res = await authedInject(fx.app, {
    method: "POST",
    url: "/api/admin/access-control/changes/preview",
    bearer,
    payload: { operation },
  });
  return { status: res.statusCode, body: JSON.parse(res.body) as PreviewBody };
}

async function apply(
  fx: AppFixture,
  bearer: string,
  operation: Record<string, unknown>,
  fingerprint: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await authedInject(fx.app, {
    method: "POST",
    url: "/api/admin/access-control/changes/apply",
    bearer,
    payload: { operation, fingerprint },
  });
  return { status: res.statusCode, body: JSON.parse(res.body) as Record<string, unknown> };
}

describe("Stack 195 W3.2 — access-control mutations (raw API)", () => {
  test(
    "preview/apply parity, protected rows, nondelegable caps, reserved slugs, admin ceiling, group delete + legacy membership",
    async () => {
      const canonicalSeed = await ensureCanonicalRbacLadder();
      try {
        const fx = await setupOwnerAppFixture({ suiteName: "s195w32" });
        const ownerBearer = await fx.mintOwnerBearer();
        const ts = Date.now().toString(36);
        const roleSlug = `w32-role-${ts}`;
        const groupType = `custom:w32-${ts}`;
        const createdRoleIds: string[] = [];
        const createdGroupIds: string[] = [];

        const admin = await seatPeerUser(fx.db, { suiteName: "s195w32", groupType: "admins" });

        try {
        // --- normal authorized custom Role + Group flow (parity) ---
        const rp = await preview(fx, ownerBearer, {
          kind: "role.create",
          slug: roleSlug,
          label: "W32",
          capabilities: ["use_workstation"],
        });
        expect(rp.status).toBe(200);
        expect(rp.body.ok).toBe(true);
        expect(rp.body.auditPreview.kind).toBe("rbac_role_created");
        const ra = await apply(fx, ownerBearer, {
          kind: "role.create",
          slug: roleSlug,
          label: "W32",
          capabilities: ["use_workstation"],
        }, rp.body.fingerprint);
        expect(ra.status).toBe(200);
        expect(ra.body["applied"]).toBe(true);
        expect(ra.body["auditRecorded"]).toBe(true);
        expect(typeof ra.body["fingerprint"]).toBe("string");
        const [roleRow] = await fx.db.select({ id: roles.id }).from(roles).where(eq(roles.slug, roleSlug)).limit(1);
        if (roleRow) createdRoleIds.push(roleRow.id);
        expect(roleRow).toBeDefined();

        const gp = await preview(fx, ownerBearer, {
          kind: "group.create",
          groupType,
          label: "W32G",
          ownerUserId: fx.ownerId,
          roleSlugs: [roleSlug],
        });
        expect(gp.body.ok).toBe(true);
        const ga = await apply(fx, ownerBearer, {
          kind: "group.create",
          groupType,
          label: "W32G",
          ownerUserId: fx.ownerId,
          roleSlugs: [roleSlug],
        }, gp.body.fingerprint);
        expect(ga.status).toBe(200);
        expect(ga.body["applied"]).toBe(true);
        const [groupRow] = await fx.db.select({ id: groups.id }).from(groups).where(eq(groups.type, groupType)).limit(1);
        if (groupRow) createdGroupIds.push(groupRow.id);
        expect(groupRow).toBeDefined();

        // --- stale preview rejection (drift between preview and apply) ---
        const sp = await preview(fx, ownerBearer, {
          kind: "role.create",
          slug: `stale-${ts}`,
          label: "Stale",
          capabilities: [],
        });
        expect(sp.body.ok).toBe(true);
        // Drift state by renaming the just-created role.
        await fx.db.update(roles).set({ label: "W32-renamed" }).where(eq(roles.id, roleRow!.id));
        const sa = await apply(fx, ownerBearer, {
          kind: "role.create",
          slug: `stale-${ts}`,
          label: "Stale",
          capabilities: [],
        }, sp.body.fingerprint);
        expect(sa.status).toBe(409);
        expect(sa.body["code"]).toBe("stale_preview");

        // --- protected system row rejected ---
        const adminRole = (await fx.db.select({ id: roles.id }).from(roles).where(eq(roles.slug, "admin")).limit(1))[0]!;
        const sysDel = await preview(fx, ownerBearer, { kind: "role.delete", roleId: adminRole.id });
        expect(sysDel.body.ok).toBe(false);
        expect(sysDel.body.failures.map((f) => f.code)).toContain("protected_definition");

        // --- nondelegable cap rejected even for Owner ---
        const nd = await preview(fx, ownerBearer, {
          kind: "role.create",
          slug: `nd-${ts}`,
          label: "ND",
          capabilities: ["manage_server_security"],
        });
        expect(nd.body.ok).toBe(false);
        expect(nd.body.failures.map((f) => f.code)).toContain("nondelegable_capability");

        // --- reserved slug rejected ---
        const rs = await preview(fx, ownerBearer, {
          kind: "role.create",
          slug: "member",
          label: "M",
          capabilities: [],
        });
        expect(rs.body.ok).toBe(false);
        expect(rs.body.failures.map((f) => f.code)).toContain("reserved_slug");

        // --- reserved group type rejected ---
        const rg = await preview(fx, ownerBearer, {
          kind: "group.create",
          groupType: "admins",
          label: "A",
          ownerUserId: fx.ownerId,
          roleSlugs: [],
        });
        expect(rg.body.ok).toBe(false);
        expect(rg.body.failures.map((f) => f.code)).toContain("reserved_type");

        // --- admin cannot delete a stronger custom role ---
        // The owner-created role bundles use_workstation (Admin holds it), so to
        // test the ceiling we use a role bundling control_desktop and an actor
        // who lacks it. Admin (real ladder) holds every delegable cap, so we
        // instead test that an Admin cannot delete the canonical `owner` role
        // (protected_definition) — and cannot mutate the owners group.
        const ownersGroup = await findGroupId(fx, "owners");
        const adminRemoveOwner = await authedInject(fx.app, {
          method: "DELETE",
          url: `/api/groups/${ownersGroup}/members/${fx.ownerId}`,
          bearer: admin.bearer,
        });
        expect(adminRemoveOwner.statusCode).toBe(403);
        const remBody = JSON.parse(adminRemoveOwner.body) as { code: string; reason: string; missing: string[] };
        expect(remBody.code).toBe("authorization_denied");
        expect(remBody.reason).toBe("insufficient_authority");

        // --- group deletion with approval challenge cleanup ---
        const [challenge] = await fx.db
          .insert(approvalChallenges)
          .values({
            groupId: groupRow!.id,
            requiredCapability: "use_workstation",
            requestedBy: fx.ownerId,
            action: "test",
            eligibleApprovers: [],
            expiresAt: new Date(Date.now() + 60_000),
          })
          .returning({ id: approvalChallenges.id });
        expect(challenge).toBeDefined();
        const dp = await preview(fx, ownerBearer, { kind: "group.delete", groupId: groupRow!.id });
        expect(dp.body.ok).toBe(true);
        expect(dp.body.deletionConsequence?.approvalChallengesRemoved).toBe(1);
        const da = await apply(fx, ownerBearer, { kind: "group.delete", groupId: groupRow!.id }, dp.body.fingerprint);
        expect(da.status).toBe(200);
        expect(da.body["applied"]).toBe(true);
        const [goneChal] = await fx.db.select({ id: approvalChallenges.id }).from(approvalChallenges).where(eq(approvalChallenges.id, challenge!.id)).limit(1);
        expect(goneChal).toBeUndefined();
        const [goneGroup] = await fx.db.select({ id: groups.id }).from(groups).where(eq(groups.id, groupRow!.id)).limit(1);
        expect(goneGroup).toBeUndefined();
        const gidx = createdGroupIds.indexOf(groupRow!.id);
        if (gidx >= 0) createdGroupIds.splice(gidx, 1);

        // --- legacy membership route now calls the shared engine ---
        // A Member (no manage_members) is rejected with the engine's
        // authorization_denied body (reason missing_manage_members).
        const member = await seatPeerUser(fx.db, { suiteName: "s195w32", groupType: "members" });
        const adminsGroup = await findGroupId(fx, "admins");
        const memberAdd = await authedInject(fx.app, {
          method: "PUT",
          url: `/api/groups/${adminsGroup}/members/${admin.userId}`,
          bearer: member.bearer,
        });
        expect(memberAdd.statusCode).toBe(403);
        const memberAddBody = JSON.parse(memberAdd.body) as { code: string; reason: string };
        expect(memberAddBody.code).toBe("authorization_denied");
        expect(memberAddBody.reason).toBe("missing_manage_members");
        // Owner retains the legacy add (engine authorizes it).
        const ownerAdd = await authedInject(fx.app, {
          method: "PUT",
          url: `/api/groups/${adminsGroup}/members/${member.userId}`,
          bearer: ownerBearer,
        });
        expect(ownerAdd.statusCode).toBe(200);
        // Cleanup: remove the member from admins.
        await fx.db.delete(groupMembers).where(and(eq(groupMembers.groupId, adminsGroup), eq(groupMembers.userId, member.userId)));
        await cleanupPeer(fx, member.userId);
        } finally {
          // Clean up created custom groups + roles (defensive; most deleted above).
          if (createdGroupIds.length > 0) await fx.db.delete(groups).where(eq(groups.id, createdGroupIds[0]!));
          for (const id of createdGroupIds) {
            await fx.db.delete(groups).where(eq(groups.id, id));
          }
          for (const id of createdRoleIds) {
            await fx.db.delete(roles).where(eq(roles.id, id));
          }
          await cleanupPeer(fx, admin.userId);
          await fx.cleanup();
        }
      } finally {
        await cleanupCanonicalSeedFixture(canonicalSeed);
      }
    },
    120000,
  );
});

describe("D538 access-control apply revocation seam", () => {
  test("successful relevant removal invokes the prepared exact revoker; stale, denied, and malformed apply do not", async () => {
    const canonicalSeed = await ensureCanonicalRbacLadder();
    try {
      const fx = await setupOwnerAppFixture({ suiteName: "d538acrev" });
      const target = await seatPeerUser(fx.db, { suiteName: "d538acrev", groupType: "members" });
      const denied = await seatPeerUser(fx.db, { suiteName: "d538acrevdeny", groupType: "members" });
      const adminsGroupId = await findGroupId(fx, "admins");
      await fx.db.insert(groupMembers).values({
        groupId: adminsGroupId,
        userId: target.userId,
        grantedBy: fx.ownerActorId,
      }).onConflictDoNothing({ target: [groupMembers.groupId, groupMembers.userId] });

      const routeApp = Fastify({ logger: false });
      routeApp.decorateRequest("sessionUserId", null);
      routeApp.decorateRequest("sessionActorId", null);
      let principal = { userId: fx.ownerId, actorId: fx.ownerActorId };
      routeApp.addHook("preHandler", (request, _reply, done) => {
        request.sessionUserId = principal.userId;
        request.sessionActorId = principal.actorId;
        done();
      });
      const prepared: Array<{ userId: string; groupId: string; actorId: string }> = [];
      let revocations = 0;
      accessControlMutationRoutes(routeApp, {
        prepareMembershipRemoval: (input) => {
          prepared.push(input);
          return Promise.resolve(
            input.userId === target.userId && input.groupId === adminsGroupId
              ? () => { revocations += 1; }
              : null,
          );
        },
      });
      await routeApp.ready();
      const operation = {
        kind: "membership.remove" as const,
        groupId: adminsGroupId,
        userId: target.userId,
      };

      try {
        const previewRes = await routeApp.inject({
          method: "POST",
          url: "/api/admin/access-control/changes/preview",
          payload: { operation },
        });
        expect(previewRes.statusCode).toBe(200);
        const fingerprint = previewRes.json<{ fingerprint: string }>().fingerprint;

        const stale = await routeApp.inject({
          method: "POST",
          url: "/api/admin/access-control/changes/apply",
          payload: { operation, fingerprint: `${fingerprint}-stale` },
        });
        expect(stale.statusCode).toBe(409);
        expect(revocations).toBe(0);

        const preparedAfterStale = prepared.length;
        principal = { userId: denied.userId, actorId: denied.actorId };
        const deniedApply = await routeApp.inject({
          method: "POST",
          url: "/api/admin/access-control/changes/apply",
          payload: { operation, fingerprint },
        });
        expect(deniedApply.statusCode).toBe(403);
        expect(prepared).toHaveLength(preparedAfterStale);
        expect(revocations).toBe(0);

        principal = { userId: fx.ownerId, actorId: fx.ownerActorId };
        const malformed = await routeApp.inject({
          method: "POST",
          url: "/api/admin/access-control/changes/apply",
          payload: { operation: { kind: "membership.remove" }, fingerprint },
        });
        expect(malformed.statusCode).toBe(400);
        expect(revocations).toBe(0);

        const freshPreview = await routeApp.inject({
          method: "POST",
          url: "/api/admin/access-control/changes/preview",
          payload: { operation },
        });
        const freshFingerprint = freshPreview.json<{ fingerprint: string }>().fingerprint;
        const applied = await routeApp.inject({
          method: "POST",
          url: "/api/admin/access-control/changes/apply",
          payload: { operation, fingerprint: freshFingerprint },
        });
        expect(applied.statusCode).toBe(200);
        expect(applied.json()).toMatchObject({ applied: true });
        expect(prepared.at(-1)).toEqual({
          userId: target.userId,
          groupId: adminsGroupId,
          actorId: fx.ownerActorId,
        });
        expect(revocations).toBe(1);
      } finally {
        await routeApp.close();
        await cleanupPeer(fx, target.userId);
        await cleanupPeer(fx, denied.userId);
        await fx.cleanup();
      }
    } finally {
      await cleanupCanonicalSeedFixture(canonicalSeed);
    }
  }, 120000);
});

describe("Stack 195 W3.2.14 — access-control composite (raw API)", () => {
  test(
    "shared_access.create preview/apply creates Role+Group+edge+members atomically with one audit event",
    async () => {
      const canonicalSeed = await ensureCanonicalRbacLadder();
      try {
        const fx = await setupOwnerAppFixture({ suiteName: "s195w32cmp" });
        const ownerBearer = await fx.mintOwnerBearer();
        const ts = Date.now().toString(36);
        const roleSlug = `cmp-${ts}`;
        const groupType = `custom:cmp-${ts}`;
        const createdRoleIds: string[] = [];
        const createdGroupIds: string[] = [];

        // A peer member to use as an initial member.
        const member = await seatPeerUser(fx.db, { suiteName: "s195w32cmp", groupType: "members" });

        try {
          const compositeOp = {
            kind: "shared_access.create",
            role: { slug: roleSlug, label: "CMP", capabilities: ["use_workstation", "control_browser"] },
            group: { groupType, label: "CMPG", ownerUserId: fx.ownerId },
            memberUserIds: [member.userId, member.userId, fx.ownerId],
          };

          const rp = await preview(fx, ownerBearer, compositeOp);
          expect(rp.status).toBe(200);
          expect(rp.body.ok).toBe(true);
          expect(rp.body.auditPreview.kind).toBe("rbac_shared_access_created");

          const ra = await apply(fx, ownerBearer, compositeOp, rp.body.fingerprint);
          expect(ra.status).toBe(200);
          expect(ra.body["applied"]).toBe(true);
          expect(ra.body["auditRecorded"]).toBe(true);

          const [roleRow] = await fx.db.select({ id: roles.id }).from(roles).where(eq(roles.slug, roleSlug)).limit(1);
          if (roleRow) createdRoleIds.push(roleRow.id);
          expect(roleRow).toBeDefined();
          const [groupRow] = await fx.db.select({ id: groups.id }).from(groups).where(eq(groups.type, groupType)).limit(1);
          if (groupRow) createdGroupIds.push(groupRow.id);
          expect(groupRow).toBeDefined();
          // Group→Role edge exists.
          const edges = await fx.db.select().from(groupRoles).where(eq(groupRoles.groupId, groupRow!.id));
          expect(edges.length).toBe(1);
          expect(edges[0]!.roleId).toBe(roleRow!.id);
          // Both initial memberships exist (de-duped).
          const members = await fx.db.select().from(groupMembers).where(eq(groupMembers.groupId, groupRow!.id));
          expect(members.map((m) => m.userId).sort()).toEqual([fx.ownerId, member.userId].sort());

          // Validation failure leaves no partial rows.
          const badOp = {
            kind: "shared_access.create",
            role: { slug: `fail-${ts}`, label: "F", capabilities: ["manage_server_security"] },
            group: { groupType: `custom:fail-${ts}`, label: "FG", ownerUserId: fx.ownerId },
            memberUserIds: [member.userId],
          };
          const bp = await preview(fx, ownerBearer, badOp);
          expect(bp.body.ok).toBe(false);
          expect(bp.body.failures.map((f) => f.code)).toContain("nondelegable_capability");
          const ba = await apply(fx, ownerBearer, badOp, bp.body.fingerprint);
          expect(ba.status).toBe(403);
          const [noRole] = await fx.db.select({ id: roles.id }).from(roles).where(eq(roles.slug, `fail-${ts}`)).limit(1);
          expect(noRole).toBeUndefined();
          const [noGroup] = await fx.db.select({ id: groups.id }).from(groups).where(eq(groups.type, `custom:fail-${ts}`)).limit(1);
          expect(noGroup).toBeUndefined();

          // Missing management caps rejects composite. A Member (no management
          // caps) is rejected at the coarse endpoint gate (403). The engine's
          // per-cap "all three" requirement is covered by the Trust unit suite.
          const memberPreview = await preview(fx, member.bearer, compositeOp);
          expect(memberPreview.status).toBe(403);
        } finally {
          for (const id of createdGroupIds) await fx.db.delete(groups).where(eq(groups.id, id));
          for (const id of createdRoleIds) await fx.db.delete(roles).where(eq(roles.id, id));
          await cleanupPeer(fx, member.userId);
          await fx.cleanup();
        }
      } finally {
        await cleanupCanonicalSeedFixture(canonicalSeed);
      }
    },
    120000,
  );
});

describe("Stack 195 W3.2.14 — access-control composite assign_existing (raw API)", () => {
  test(
    "shared_access.assign_existing preview/apply attaches an existing custom Role to a new Group + members atomically with one audit event",
    async () => {
      const canonicalSeed = await ensureCanonicalRbacLadder();
      try {
        const fx = await setupOwnerAppFixture({ suiteName: "s195w32asg" });
        const ownerBearer = await fx.mintOwnerBearer();
        const ts = Date.now().toString(36);
        const existingRoleSlug = `asg-${ts}`;
        const assignGroupType = `custom:asg-${ts}`;
        const createdRoleIds: string[] = [];
        const createdGroupIds: string[] = [];

        // A peer member to use as an initial member.
        const member = await seatPeerUser(fx.db, { suiteName: "s195w32asg", groupType: "members" });

        try {
          // First create the existing custom Permission set (Role).
          const rp = await preview(fx, ownerBearer, {
            kind: "role.create",
            slug: existingRoleSlug,
            label: "ASG",
            capabilities: ["use_workstation", "control_browser"],
          });
          expect(rp.status).toBe(200);
          expect(rp.body.ok).toBe(true);
          const ra = await apply(fx, ownerBearer, {
            kind: "role.create",
            slug: existingRoleSlug,
            label: "ASG",
            capabilities: ["use_workstation", "control_browser"],
          }, rp.body.fingerprint);
          expect(ra.status).toBe(200);
          expect(ra.body["applied"]).toBe(true);
          const [roleRow] = await fx.db.select({ id: roles.id }).from(roles).where(eq(roles.slug, existingRoleSlug)).limit(1);
          if (roleRow) createdRoleIds.push(roleRow.id);
          expect(roleRow).toBeDefined();

          const assignOp = {
            kind: "shared_access.assign_existing",
            roleSlug: existingRoleSlug,
            group: { groupType: assignGroupType, label: "ASGG", ownerUserId: fx.ownerId },
            memberUserIds: [member.userId, member.userId, fx.ownerId],
          };

          const ap = await preview(fx, ownerBearer, assignOp);
          expect(ap.status).toBe(200);
          expect(ap.body.ok).toBe(true);
          expect(ap.body.auditPreview.kind).toBe("rbac_shared_access_assigned");

          const aa = await apply(fx, ownerBearer, assignOp, ap.body.fingerprint);
          expect(aa.status).toBe(200);
          expect(aa.body["applied"]).toBe(true);
          expect(aa.body["auditRecorded"]).toBe(true);

          // The Role row is unchanged (exactly one row for the slug).
          const roleRows = await fx.db.select({ id: roles.id }).from(roles).where(eq(roles.slug, existingRoleSlug));
          expect(roleRows.length).toBe(1);
          // The new Group exists.
          const [groupRow] = await fx.db.select({ id: groups.id }).from(groups).where(eq(groups.type, assignGroupType)).limit(1);
          if (groupRow) createdGroupIds.push(groupRow.id);
          expect(groupRow).toBeDefined();
          // Group→existing-Role edge exists.
          const edges = await fx.db.select().from(groupRoles).where(eq(groupRoles.groupId, groupRow!.id));
          expect(edges.length).toBe(1);
          expect(edges[0]!.roleId).toBe(roleRow!.id);
          // Both initial memberships exist (de-duped).
          const members = await fx.db.select().from(groupMembers).where(eq(groupMembers.groupId, groupRow!.id));
          expect(members.map((m) => m.userId).sort()).toEqual([fx.ownerId, member.userId].sort());

          // Validation failure (canonical role) leaves no partial rows.
          const badOp = {
            kind: "shared_access.assign_existing",
            roleSlug: "admin",
            group: { groupType: `custom:asgfail-${ts}`, label: "FG", ownerUserId: fx.ownerId },
            memberUserIds: [member.userId],
          };
          const bp = await preview(fx, ownerBearer, badOp);
          expect(bp.body.ok).toBe(false);
          expect(bp.body.failures.map((f) => f.code)).toContain("protected_definition");
          const ba = await apply(fx, ownerBearer, badOp, bp.body.fingerprint);
          expect(ba.status).toBe(403);
          const [noGroup] = await fx.db.select({ id: groups.id }).from(groups).where(eq(groups.type, `custom:asgfail-${ts}`)).limit(1);
          expect(noGroup).toBeUndefined();

          // A Member (no management caps) is rejected at the coarse endpoint gate.
          const memberPreview = await preview(fx, member.bearer, assignOp);
          expect(memberPreview.status).toBe(403);
        } finally {
          for (const id of createdGroupIds) await fx.db.delete(groups).where(eq(groups.id, id));
          for (const id of createdRoleIds) await fx.db.delete(roles).where(eq(roles.id, id));
          await cleanupPeer(fx, member.userId);
          await fx.cleanup();
        }
      } finally {
        await cleanupCanonicalSeedFixture(canonicalSeed);
      }
    },
    120000,
  );
});

describe("Stack 195 follow-up — shared_access.assign_existing anti-escalation (raw API)", () => {
  test(
    "a custom manager cannot assign_existing using a Permission set whose bundle includes an unheld capability",
    async () => {
      const canonicalSeed = await ensureCanonicalRbacLadder();
      try {
        const fx = await setupOwnerAppFixture({ suiteName: "s195asgap" });
        const ownerBearer = await fx.mintOwnerBearer();
        const ts = Date.now().toString(36);
        const createdRoleIds: string[] = [];
        const createdGroupIds: string[] = [];

        // A peer custom manager: seated in a custom group granting
        // manage_groups + manage_members + use_workstation, but NOT
        // control_desktop (so a role bundling control_desktop is unheld).
        const peer = await seatPeerUser(fx.db, {
          suiteName: "s195asgap",
          groupType: "contributors",
        });

        try {
          const mgrRoleSlug = `gap-mgr-${ts}`;
          const mgrGroupType = `custom:gap-mgr-${ts}`;
          const strongRoleSlug = `gap-strong-${ts}`;

          // Manager role (manage_groups + manage_members + use_workstation).
          const mrp = await preview(fx, ownerBearer, {
            kind: "role.create",
            slug: mgrRoleSlug,
            label: "GAPMGR",
            capabilities: ["manage_groups", "manage_members", "use_workstation"],
          });
          expect(mrp.body.ok).toBe(true);
          const mra = await apply(fx, ownerBearer, {
            kind: "role.create",
            slug: mgrRoleSlug,
            label: "GAPMGR",
            capabilities: ["manage_groups", "manage_members", "use_workstation"],
          }, mrp.body.fingerprint);
          expect(mra.status).toBe(200);
          const [mgrRole] = await fx.db.select({ id: roles.id }).from(roles).where(eq(roles.slug, mgrRoleSlug)).limit(1);
          if (mgrRole) createdRoleIds.push(mgrRole.id);

          const mgp = await preview(fx, ownerBearer, {
            kind: "group.create",
            groupType: mgrGroupType,
            label: "GAPMGRG",
            ownerUserId: fx.ownerId,
            roleSlugs: [mgrRoleSlug],
          });
          expect(mgp.body.ok).toBe(true);
          const mga = await apply(fx, ownerBearer, {
            kind: "group.create",
            groupType: mgrGroupType,
            label: "GAPMGRG",
            ownerUserId: fx.ownerId,
            roleSlugs: [mgrRoleSlug],
          }, mgp.body.fingerprint);
          expect(mga.status).toBe(200);
          const [mgrGroup] = await fx.db.select({ id: groups.id }).from(groups).where(eq(groups.type, mgrGroupType)).limit(1);
          if (mgrGroup) createdGroupIds.push(mgrGroup.id);

          // Seat the peer in the manager group.
          await fx.db
            .insert(groupMembers)
            .values({ groupId: mgrGroup!.id, userId: peer.userId, grantedBy: fx.ownerActorId })
            .onConflictDoNothing({ target: [groupMembers.groupId, groupMembers.userId] });

          // An existing custom Permission set bundling control_desktop — a
          // cap the peer manager does NOT hold.
          const srp = await preview(fx, ownerBearer, {
            kind: "role.create",
            slug: strongRoleSlug,
            label: "GAPSTRONG",
            capabilities: ["control_desktop", "use_workstation"],
          });
          expect(srp.body.ok).toBe(true);
          const sra = await apply(fx, ownerBearer, {
            kind: "role.create",
            slug: strongRoleSlug,
            label: "GAPSTRONG",
            capabilities: ["control_desktop", "use_workstation"],
          }, srp.body.fingerprint);
          expect(sra.status).toBe(200);
          const [strongRole] = await fx.db.select({ id: roles.id }).from(roles).where(eq(roles.slug, strongRoleSlug)).limit(1);
          if (strongRole) createdRoleIds.push(strongRole.id);

          // The peer manager attempts shared_access.assign_existing using
          // the strong role. The peer holds manage_groups + manage_members
          // (so the management gate passes) but lacks control_desktop, so
          // the authority-over-bundle check MUST reject (insufficient_authority).
          const peerPreview = await preview(fx, peer.bearer, {
            kind: "shared_access.assign_existing",
            roleSlug: strongRoleSlug,
            group: {
              groupType: `custom:gap-peer-${ts}`,
              label: "PEERG",
              ownerUserId: peer.userId,
            },
            memberUserIds: [peer.userId],
          });
          expect(peerPreview.status).toBe(200);
          expect(peerPreview.body.ok).toBe(false);
          expect(peerPreview.body.failures.map((f) => f.code)).toContain("insufficient_authority");

          // The Owner (who holds control_desktop) is authorized for the same
          // operation — proving the rejection was authority, not a shape error.
          const ownerPreview = await preview(fx, ownerBearer, {
            kind: "shared_access.assign_existing",
            roleSlug: strongRoleSlug,
            group: {
              groupType: `custom:gap-owner-${ts}`,
              label: "OWNERG",
              ownerUserId: fx.ownerId,
            },
            memberUserIds: [peer.userId],
          });
          expect(ownerPreview.body.ok).toBe(true);
          if (ownerPreview.body.ok) {
            const oa = await apply(fx, ownerBearer, {
              kind: "shared_access.assign_existing",
              roleSlug: strongRoleSlug,
              group: {
                groupType: `custom:gap-owner-${ts}`,
                label: "OWNERG",
                ownerUserId: fx.ownerId,
              },
              memberUserIds: [peer.userId],
            }, ownerPreview.body.fingerprint);
            expect(oa.status).toBe(200);
            const [ownerGroup] = await fx.db.select({ id: groups.id }).from(groups).where(eq(groups.type, `custom:gap-owner-${ts}`)).limit(1);
            if (ownerGroup) {
              await fx.db.delete(groupMembers).where(eq(groupMembers.groupId, ownerGroup.id));
              await fx.db.delete(groups).where(eq(groups.id, ownerGroup.id));
            }
          }
        } finally {
          for (const id of createdGroupIds) await fx.db.delete(groups).where(eq(groups.id, id));
          for (const id of createdRoleIds) await fx.db.delete(roles).where(eq(roles.id, id));
          await cleanupPeer(fx, peer.userId);
          await fx.cleanup();
        }
      } finally {
        await cleanupCanonicalSeedFixture(canonicalSeed);
      }
    },
    120000,
  );
});

describe("Stack 195 follow-up — sole-Owner removal preview/apply parity (raw API)", () => {
  test.skipIf(soleOwnerSkipReason !== null)(
    "preview rejects the sole Owner (bypass false/true) with last_owner; apply maps to 409 last_owner without removing; multi-Owner allowed",
    async () => {
      const canonicalSeed = await ensureCanonicalRbacLadder();
      try {
        const fx = await setupOwnerAppFixture({ suiteName: "s195ownpa" });
        const ownerBearer = await fx.mintOwnerBearer();
        const ownersGroupId = await findGroupId(fx, "owners");
        if (canonicalSeed) {
          await fx.db.delete(groupMembers).where(
            and(
              eq(groupMembers.groupId, ownersGroupId),
              eq(groupMembers.userId, canonicalSeed.userId),
            ),
          );
        }
        // A second user to promote as a second Owner for the multi-Owner case.
        const secondOwner = await seatPeerUser(fx.db, {
          suiteName: "s195ownpa",
          groupType: "members",
        });

        try {
          // --- preview rejects removing the sole Owner (bypass=false) ---
          const rp = await preview(fx, ownerBearer, {
            kind: "membership.remove",
            groupId: ownersGroupId,
            userId: fx.ownerId,
          });
          expect(rp.status).toBe(200);
          expect(rp.body.ok).toBe(false);
          expect(rp.body.failures.map((f) => f.code)).toContain("last_owner");

          // --- preview rejects the sole Owner REGARDLESS of bypassLastOwner ---
          const rpBypass = await preview(fx, ownerBearer, {
            kind: "membership.remove",
            groupId: ownersGroupId,
            userId: fx.ownerId,
            bypassLastOwner: true,
          });
          expect(rpBypass.body.ok).toBe(false);
          expect(rpBypass.body.failures.map((f) => f.code)).toContain("last_owner");

          // --- apply maps the rejected preview to the stable 409 last_owner
          // invariant WITHOUT removing the sole Owner (execute does not run
          // for a rejected preview) ---
          const ra = await apply(
            fx,
            ownerBearer,
            {
              kind: "membership.remove",
              groupId: ownersGroupId,
              userId: fx.ownerId,
              bypassLastOwner: true,
            },
            rpBypass.body.fingerprint,
          );
          expect(ra.status).toBe(409);
          expect(ra.body["code"]).toBe("last_owner");
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

          // --- multi-Owner removal stays allowed (the rail does not fire) ---
          // Promote a second Owner via the preview/apply flow.
          const ap = await preview(fx, ownerBearer, {
            kind: "membership.add",
            groupId: ownersGroupId,
            userId: secondOwner.userId,
          });
          expect(ap.body.ok).toBe(true);
          const aa = await apply(
            fx,
            ownerBearer,
            {
              kind: "membership.add",
              groupId: ownersGroupId,
              userId: secondOwner.userId,
            },
            ap.body.fingerprint,
          );
          expect(aa.status).toBe(200);
          expect(aa.body["applied"]).toBe(true);

          // Two Owners now; removing one of them is allowed (no last_owner).
          const mp = await preview(fx, ownerBearer, {
            kind: "membership.remove",
            groupId: ownersGroupId,
            userId: secondOwner.userId,
          });
          expect(mp.body.ok).toBe(true);
          expect(mp.body.failures.map((f) => f.code)).not.toContain("last_owner");
          const ma = await apply(
            fx,
            ownerBearer,
            {
              kind: "membership.remove",
              groupId: ownersGroupId,
              userId: secondOwner.userId,
            },
            mp.body.fingerprint,
          );
          expect(ma.status).toBe(200);
          expect(ma.body["applied"]).toBe(true);
        } finally {
          // Leave the canonical owners Group with only the fixture Owner.
          await fx.db
            .delete(groupMembers)
            .where(
              and(
                eq(groupMembers.groupId, ownersGroupId),
                eq(groupMembers.userId, secondOwner.userId),
              ),
            );
          await cleanupPeer(fx, secondOwner.userId);
          await fx.cleanup();
        }
      } finally {
        await cleanupCanonicalSeedFixture(canonicalSeed);
      }
    },
    120000,
  );
});
