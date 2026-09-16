import { describe, expect, test } from "bun:test";
import { eq, groupMembers, groups, profiles, users } from "@nautilo/db";
import { setupOwnerAppFixture, seatPeerUser } from "./helpers/app-fixture";
import { authedInject } from "./helpers/request-helpers";

describe("admin users soft delete (D219 S3)", () => {
  test("disable blocks the next request, enable restores, and guard rails hold", async () => {
    const fx = await setupOwnerAppFixture({ suiteName: "d219soft" });
    let peerUserId: string | null = null;
    let federatedUserId: string | null = null;
    try {
      const ownerBearer = await fx.mintOwnerBearer();
      const peer = await seatPeerUser(fx.db, { suiteName: "d219soft", groupType: "members" });
      peerUserId = peer.userId;

      const disabled = await authedInject(fx.app, {
        method: "POST",
        url: `/api/admin/users/${peer.userId}/disable`,
        bearer: ownerBearer,
        payload: { reason: "compromised" },
      });
      expect(disabled.statusCode).toBe(200);
      expect(JSON.parse(disabled.body)).toMatchObject({
        ok: true,
        mutation: { stateChanged: true, retrySafe: true, receiptId: peer.userId },
      });
      const disabledAgain = await authedInject(fx.app, {
        method: "POST",
        url: `/api/admin/users/${peer.userId}/disable`,
        bearer: ownerBearer,
        payload: { reason: "must not replace the first reason" },
      });
      expect(JSON.parse(disabledAgain.body)).toMatchObject({
        ok: true,
        mutation: { stateChanged: false, auditRecorded: false, retrySafe: true },
      });
      const [afterDisable] = await fx.db
        .select({
          disabledAt: users.disabledAt,
          disabledBy: users.disabledBy,
          disabledReason: users.disabledReason,
        })
        .from(users)
        .where(eq(users.id, peer.userId))
        .limit(1);
      expect(afterDisable?.disabledAt).toBeInstanceOf(Date);
      expect(afterDisable?.disabledBy).toBe(fx.ownerId);
      expect(afterDisable?.disabledReason).toBe("compromised");

      const blocked = await authedInject(fx.app, {
        method: "GET",
        url: "/api/auth/whoami",
        bearer: peer.bearer,
      });
      expect(blocked.statusCode).toBe(401);

      const enabled = await authedInject(fx.app, {
        method: "POST",
        url: `/api/admin/users/${peer.userId}/enable`,
        bearer: ownerBearer,
      });
      expect(enabled.statusCode).toBe(200);
      expect(JSON.parse(enabled.body)).toMatchObject({
        ok: true,
        mutation: { stateChanged: true, retrySafe: true, receiptId: peer.userId },
      });
      const enabledAgain = await authedInject(fx.app, {
        method: "POST",
        url: `/api/admin/users/${peer.userId}/enable`,
        bearer: ownerBearer,
        payload: {},
      });
      expect(JSON.parse(enabledAgain.body)).toMatchObject({
        ok: true,
        mutation: { stateChanged: false, auditRecorded: false, retrySafe: true },
      });
      const restored = await authedInject(fx.app, {
        method: "GET",
        url: "/api/auth/whoami",
        bearer: peer.bearer,
      });
      expect(restored.statusCode).toBe(200);

      // Last-owner guard: the server blocks disabling the SOLE remaining
      // owner (409 `last_owner`). On a populated/shared instance other
      // owners exist (e.g. the operator), so disabling the fixture owner is
      // legitimately allowed. Branch on the real owners-group membership so
      // this holds on both a fresh single-owner DB and a non-fresh one.
      const [ownersGroup] = await fx.db
        .select({ id: groups.id })
        .from(groups)
        .where(eq(groups.type, "owners"))
        .limit(1);
      const ownerMembers = ownersGroup
        ? await fx.db
            .select({ userId: groupMembers.userId })
            .from(groupMembers)
            .where(eq(groupMembers.groupId, ownersGroup.id))
        : [];
      const otherOwners = ownerMembers.filter((r) => r.userId !== fx.ownerId);

      const lastOwner = await authedInject(fx.app, {
        method: "POST",
        url: `/api/admin/users/${fx.ownerId}/disable`,
        bearer: ownerBearer,
        payload: { reason: "do not allow" },
      });
      if (otherOwners.length === 0) {
        // Fixture owner IS the last owner → guard fires.
        expect(lastOwner.statusCode).toBe(409);
        expect((JSON.parse(lastOwner.body) as { code?: string }).code).toBe("last_owner");
      } else {
        // Even when another owner exists, the admin route does not permit a
        // caller to accidentally suspend its own current session.
        expect(lastOwner.statusCode).toBe(409);
        expect((JSON.parse(lastOwner.body) as { code?: string }).code).toBe("self_target");
      }

      const [federated] = await fx.db
        .insert(users)
        .values({
          name: "Remote User",
          email: "d219soft-remote@test.local",
          handle: `d219softfed${Date.now().toString(36)}`,
          server: "remote.example",
        })
        .returning({ id: users.id });
      federatedUserId = federated?.id ?? null;
      const federatedDisable = await authedInject(fx.app, {
        method: "POST",
        url: `/api/admin/users/${federatedUserId}/disable`,
        bearer: ownerBearer,
        payload: {},
      });
      expect(federatedDisable.statusCode).toBe(422);
      expect((JSON.parse(federatedDisable.body) as { code?: string }).code).toBe("federated_user");
    } finally {
      if (peerUserId) {
        await fx.db.delete(profiles).where(eq(profiles.userId, peerUserId));
        await fx.db.delete(users).where(eq(users.id, peerUserId));
      }
      if (federatedUserId) {
        await fx.db.delete(users).where(eq(users.id, federatedUserId));
      }
      await fx.cleanup();
    }
  });
});
