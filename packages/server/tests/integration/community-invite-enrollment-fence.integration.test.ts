import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../.env") });

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  and,
  eq,
  groupMembers,
  groupRoles,
  groups,
  invites,
  roles,
  users,
} from "@nautilo/db";
import { setupOwnerAppFixture, type AppFixture } from "./helpers/app-fixture";
import { authedInject } from "./helpers/request-helpers";

describe("server invite enrollment boundary", () => {
  let fixture!: AppFixture;
  let bearer: string;

  beforeAll(async () => {
    fixture = await setupOwnerAppFixture({ suiteName: "invitefence" });
    bearer = await fixture.mintOwnerBearer();
  });

  afterAll(async () => {
    if (fixture) await fixture.cleanup();
  });

  test("owner cannot mint a Community enrollment invite while Guest enrollment remains available", async () => {
    const before = await fixture.db
      .select({ id: invites.id })
      .from(invites)
      .where(eq(invites.createdBy, fixture.ownerId));

    const blocked = await authedInject(fixture.app, {
      method: "POST",
      url: "/api/invites",
      bearer,
      payload: {
        kind: "server",
        targetGroupRoleSlug: "community",
        maxUses: 1,
      },
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json<{ error: string }>()).toEqual({
      error: "target_role_forbidden",
    });

    const afterBlocked = await fixture.db
      .select({ id: invites.id })
      .from(invites)
      .where(eq(invites.createdBy, fixture.ownerId));
    expect(afterBlocked.map((row) => row.id).sort()).toEqual(
      before.map((row) => row.id).sort(),
    );

    const allowed = await authedInject(fixture.app, {
      method: "POST",
      url: "/api/invites",
      bearer,
      payload: {
        kind: "server",
        targetGroupRoleSlug: "guest",
        maxUses: 1,
      },
    });
    expect(allowed.statusCode).toBe(200);
    const allowedBody = allowed.json<{
      id: string;
      kind: string;
      token: string;
    }>();
    expect(allowedBody.kind).toBe("server");
    expect(allowedBody.token).toMatch(/^inv_[A-Za-z0-9_-]{32}$/u);

    const [persisted] = await fixture.db
      .select({ targetGroupId: invites.targetGroupId })
      .from(invites)
      .innerJoin(groups, eq(groups.id, invites.targetGroupId))
      .where(
        and(
          eq(invites.id, allowedBody.id),
          eq(groups.type, "guests"),
        ),
      )
      .limit(1);
    expect(persisted?.targetGroupId).toBeString();
  });

  test("direct provisioning rejects Community before creating a user while Guest provisioning remains available", async () => {
    const priorSecret = process.env["NAUTILO_PROVISIONING_IDEMPOTENCY_SECRET"];
    process.env["NAUTILO_PROVISIONING_IDEMPOTENCY_SECRET"] =
      "integration-only-community-fence-secret";
    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    const communityHandle = `community${suffix}`;
    const guestHandle = `guest${suffix}`;
    let guestUserId: string | null = null;

    try {
      const blocked = await authedInject(fixture.app, {
        method: "POST",
        url: "/api/admin/users/provision",
        bearer,
        headers: { "idempotency-key": `community-fence-${crypto.randomUUID()}` },
        payload: {
          handle: communityHandle,
          displayName: "Community Fence Target",
          roleSlug: "community",
        },
      });
      expect(blocked.statusCode).toBe(400);
      expect(blocked.json<{ code: string }>()).toEqual({
        code: "invalid_provision_intent",
      });
      expect(
        await fixture.db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.handle, communityHandle)),
      ).toHaveLength(0);

      const allowed = await authedInject(fixture.app, {
        method: "POST",
        url: "/api/admin/users/provision",
        bearer,
        headers: { "idempotency-key": `guest-enrollment-${crypto.randomUUID()}` },
        payload: {
          handle: guestHandle,
          displayName: "Guest Enrollment Target",
          roleSlug: "guest",
        },
      });
      expect(allowed.statusCode).toBe(200);
      const body = allowed.json<{ memberId: string; roleSlug: string }>();
      guestUserId = body.memberId;
      expect(body.roleSlug).toBe("guest");

      const memberships = await fixture.db
        .select({ type: groups.type })
        .from(groupMembers)
        .innerJoin(groups, eq(groups.id, groupMembers.groupId))
        .where(eq(groupMembers.userId, guestUserId));
      expect(memberships.map((row) => row.type)).toContain("guests");
    } finally {
      if (guestUserId) {
        await authedInject(fixture.app, {
          method: "DELETE",
          url: `/api/admin/users/${guestUserId}`,
          bearer,
        });
        await fixture.db.delete(users).where(eq(users.id, guestUserId));
      }
      if (priorSecret === undefined) {
        delete process.env["NAUTILO_PROVISIONING_IDEMPOTENCY_SECRET"];
      } else {
        process.env["NAUTILO_PROVISIONING_IDEMPOTENCY_SECRET"] = priorSecret;
      }
    }
  });

  test("membership mutation rejects a custom Group carrying Community while an equivalent Guest Group remains usable", async () => {
    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    const [target] = await fixture.db
      .insert(users)
      .values({
        name: "Custom Group Enrollment Target",
        email: `custom-group-${suffix}@test.local`,
        handle: `customgroup${suffix}`,
        externalId: crypto.randomUUID(),
      })
      .returning({ id: users.id });
    if (!target) throw new Error("custom Group target insert failed");

    const roleRows = await fixture.db
      .select({ id: roles.id, slug: roles.slug })
      .from(roles);
    const communityRole = roleRows.find((row) => row.slug === "community");
    const guestRole = roleRows.find((row) => row.slug === "guest");
    if (!communityRole || !guestRole) {
      throw new Error("canonical Community or Guest Role missing");
    }

    const createdGroups = await fixture.db
      .insert(groups)
      .values([
        {
          type: `custom-community-${suffix}`,
          label: "Custom Community",
          ownerId: fixture.ownerId,
          isSystem: false,
        },
        {
          type: `custom-guest-${suffix}`,
          label: "Custom Guest",
          ownerId: fixture.ownerId,
          isSystem: false,
        },
      ])
      .returning({ id: groups.id, type: groups.type });
    const communityGroup = createdGroups.find((row) =>
      row.type.startsWith("custom-community-"),
    );
    const guestGroup = createdGroups.find((row) =>
      row.type.startsWith("custom-guest-"),
    );
    if (!communityGroup || !guestGroup) {
      throw new Error("custom Group insert failed");
    }

    try {
      await fixture.db.insert(groupRoles).values([
        { groupId: communityGroup.id, roleId: communityRole.id },
        { groupId: guestGroup.id, roleId: guestRole.id },
      ]);

      const blocked = await authedInject(fixture.app, {
        method: "PUT",
        url: `/api/groups/${communityGroup.id}/members/${target.id}`,
        bearer,
      });
      expect(blocked.statusCode).toBe(403);
      expect(blocked.json<{ code: string; reason: string }>()).toMatchObject({
        code: "authorization_denied",
        reason: "community_enrollment_unavailable",
      });
      expect(
        await fixture.db
          .select({ userId: groupMembers.userId })
          .from(groupMembers)
          .where(
            and(
              eq(groupMembers.groupId, communityGroup.id),
              eq(groupMembers.userId, target.id),
            ),
          ),
      ).toHaveLength(0);

      const allowed = await authedInject(fixture.app, {
        method: "PUT",
        url: `/api/groups/${guestGroup.id}/members/${target.id}`,
        bearer,
      });
      expect(allowed.statusCode).toBe(200);
      expect(allowed.json<{ ok: boolean }>()).toMatchObject({ ok: true });
      expect(
        await fixture.db
          .select({ userId: groupMembers.userId })
          .from(groupMembers)
          .where(
            and(
              eq(groupMembers.groupId, guestGroup.id),
              eq(groupMembers.userId, target.id),
            ),
          ),
      ).toHaveLength(1);
    } finally {
      await fixture.db
        .delete(groupMembers)
        .where(eq(groupMembers.userId, target.id));
      await fixture.db
        .delete(groupRoles)
        .where(eq(groupRoles.groupId, communityGroup.id));
      await fixture.db
        .delete(groupRoles)
        .where(eq(groupRoles.groupId, guestGroup.id));
      await fixture.db.delete(groups).where(eq(groups.id, communityGroup.id));
      await fixture.db.delete(groups).where(eq(groups.id, guestGroup.id));
      await fixture.db.delete(users).where(eq(users.id, target.id));
    }
  });

  test("role mutation cannot assign Community to an occupied custom Group", async () => {
    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    const [target] = await fixture.db
      .insert(users)
      .values({
        name: "Occupied Custom Group Target",
        email: `occupied-group-${suffix}@test.local`,
        handle: `occupiedgroup${suffix}`,
        externalId: crypto.randomUUID(),
      })
      .returning({ id: users.id });
    if (!target) throw new Error("occupied custom Group target insert failed");

    const [guestRole] = await fixture.db
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.slug, "guest"))
      .limit(1);
    if (!guestRole) throw new Error("canonical Guest Role missing");

    const [group] = await fixture.db
      .insert(groups)
      .values({
        type: `occupied-custom-${suffix}`,
        label: "Occupied Custom Group",
        ownerId: fixture.ownerId,
        isSystem: false,
      })
      .returning({ id: groups.id });
    if (!group) throw new Error("occupied custom Group insert failed");

    try {
      await fixture.db.insert(groupRoles).values({
        groupId: group.id,
        roleId: guestRole.id,
      });
      await fixture.db.insert(groupMembers).values({
        groupId: group.id,
        userId: target.id,
        grantedBy: fixture.ownerActorId,
      });
      const operation = {
        kind: "group.set_roles",
        groupId: group.id,
        roleSlugs: ["community"],
      };

      const preview = await authedInject(fixture.app, {
        method: "POST",
        url: "/api/admin/access-control/changes/preview",
        bearer,
        payload: { operation },
      });
      expect(preview.statusCode).toBe(200);
      const previewBody = preview.json<{
        ok: boolean;
        fingerprint: string;
        failures: Array<{ code: string }>;
      }>();
      expect(previewBody.ok).toBe(false);
      expect(previewBody.failures.map((failure) => failure.code)).toContain(
        "community_enrollment_unavailable",
      );

      const applied = await authedInject(fixture.app, {
        method: "POST",
        url: "/api/admin/access-control/changes/apply",
        bearer,
        payload: { operation, fingerprint: previewBody.fingerprint },
      });
      expect(applied.statusCode).toBe(403);
      expect(
        applied
          .json<{ code: string; failures: Array<{ code: string }> }>()
          .failures.map((failure) => failure.code),
      ).toContain("community_enrollment_unavailable");

      const remainingRoles = await fixture.db
        .select({ roleId: groupRoles.roleId })
        .from(groupRoles)
        .where(eq(groupRoles.groupId, group.id));
      expect(remainingRoles).toEqual([{ roleId: guestRole.id }]);
      const remainingMembers = await fixture.db
        .select({ userId: groupMembers.userId })
        .from(groupMembers)
        .where(eq(groupMembers.groupId, group.id));
      expect(remainingMembers).toEqual([{ userId: target.id }]);
    } finally {
      await fixture.db
        .delete(groupMembers)
        .where(eq(groupMembers.groupId, group.id));
      await fixture.db
        .delete(groupRoles)
        .where(eq(groupRoles.groupId, group.id));
      await fixture.db.delete(groups).where(eq(groups.id, group.id));
      await fixture.db.delete(users).where(eq(users.id, target.id));
    }
  });
});
