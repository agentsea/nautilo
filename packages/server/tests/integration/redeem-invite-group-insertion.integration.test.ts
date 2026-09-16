/**
 * M128 regression — kind=server redeem must insert group_members (test001).
 */
import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../.env") });

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { eq, groupMembers, groups, invites, users } from "@nautilo/db";
import { pickHighestRoleSlug } from "@nautilo/api-client";
import { findUserHighestRoleSlug } from "@nautilo/trust";
import { setupOwnerAppFixture, type AppFixture } from "./helpers/app-fixture";
import { authedInject } from "./helpers/request-helpers";
import {
  redeemServerInviteToken,
  cleanupInvitee,
} from "./helpers/invite-redeem-helpers";

describe("server invite redeem — group_members insertion regression", () => {
  let fx: AppFixture;
  let bearer: string;

  beforeAll(async () => {
    fx = await setupOwnerAppFixture({ suiteName: "m128reg" });
    bearer = await fx.mintOwnerBearer();
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  test("guest-rung invite inserts exactly one guests group_members row", async () => {
    const mintRes = await authedInject(fx.app, {
      method: "POST",
      url: "/api/invites",
      bearer,
      payload: { kind: "server", targetGroupRoleSlug: "guest" },
    });
    expect(mintRes.statusCode).toBe(200);
    const { token } = JSON.parse(mintRes.body) as { token: string };

    const handle = `regguest${Date.now().toString(36).slice(-6)}`;
    const redeem = await redeemServerInviteToken(token, handle);
    expect(redeem.ok).toBe(true);
    if (!redeem.ok) return;

    const gmRows = await fx.db
      .select({ groupType: groups.type })
      .from(groupMembers)
      .innerJoin(groups, eq(groupMembers.groupId, groups.id))
      .where(eq(groupMembers.userId, redeem.newUserId));
    expect(gmRows.length).toBe(1);
    expect(gmRows[0]!.groupType).toBe("guests");

    expect(await findUserHighestRoleSlug(redeem.newUserId)).toBe("guest");

    const [userRow] = await fx.db
      .select({ externalId: users.externalId })
      .from(users)
      .where(eq(users.id, redeem.newUserId))
      .limit(1);
    expect(userRow?.externalId).toBeTruthy();
    const sessionBearer = await fx.mintSessionBearerForUser(
      redeem.newActorId,
      redeem.newUserId,
    );
    const whoRes = await fx.app.inject({
      method: "GET",
      url: "/api/auth/whoami",
      headers: { authorization: `Bearer ${sessionBearer}` },
    });
    expect(whoRes.statusCode).toBe(200);
    const who = JSON.parse(whoRes.body) as import("@nautilo/types").WhoamiResponse;
    expect(pickHighestRoleSlug(who.groups)).toBe("guest");
    const guestsChip = who.groups.find((g) => g.type === "guests");
    expect(guestsChip).toBeDefined();
    expect(guestsChip!.roleSlug).toBe("guest");

    await cleanupInvitee(fx, redeem.newUserId);
  });

  test("rejects replay, revoked, expired, denied, and concurrent one-use journeys", async () => {
    const createdUserIds: string[] = [];
    const mint = async () => {
      const response = await authedInject(fx.app, {
        method: "POST",
        url: "/api/invites",
        bearer,
        payload: { kind: "server", targetGroupRoleSlug: "member", maxUses: 1 },
      });
      expect(response.statusCode).toBe(200);
      return JSON.parse(response.body) as { id: string; token: string };
    };

    try {
      const denied = await fx.app.inject({
        method: "POST",
        url: "/api/invites",
        payload: { kind: "server", targetGroupRoleSlug: "member" },
      });
      expect(denied.statusCode).toBe(401);

      const exhaustedInvite = await mint();
      const first = await redeemServerInviteToken(exhaustedInvite.token, `journey${Date.now().toString(36)}`);
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      createdUserIds.push(first.newUserId);

      const replay = await redeemServerInviteToken(exhaustedInvite.token, `replay${Date.now().toString(36)}`);
      expect(replay).toMatchObject({ ok: false, httpStatus: 410, code: "used_up" });

      const revokedInvite = await mint();
      const revokedResponse = await authedInject(fx.app, {
        method: "DELETE",
        url: `/api/invites/${revokedInvite.id}`,
        bearer,
      });
      expect(revokedResponse.statusCode).toBe(200);
      const revoked = await redeemServerInviteToken(revokedInvite.token, `revoked${Date.now().toString(36)}`);
      expect(revoked).toMatchObject({ ok: false, httpStatus: 410, code: "revoked" });

      const expiredInvite = await mint();
      await fx.db
        .update(invites)
        .set({ expiresAt: new Date(Date.now() - 60_000) })
        .where(eq(invites.id, expiredInvite.id));
      const expired = await redeemServerInviteToken(expiredInvite.token, `expired${Date.now().toString(36)}`);
      expect(expired).toMatchObject({ ok: false, httpStatus: 410, code: "expired" });

      const racingInvite = await mint();
      const racing = await Promise.all([
        redeemServerInviteToken(racingInvite.token, `racea${Date.now().toString(36)}`),
        redeemServerInviteToken(racingInvite.token, `raceb${Date.now().toString(36)}`),
      ]);
      expect(racing.filter((result) => result.ok)).toHaveLength(1);
      expect(racing.filter((result) => !result.ok && result.code === "used_up")).toHaveLength(1);
      for (const result of racing) {
        if (result.ok) createdUserIds.push(result.newUserId);
      }
    } finally {
      for (const userId of createdUserIds) await cleanupInvitee(fx, userId);
    }
  }, 60000);
});
