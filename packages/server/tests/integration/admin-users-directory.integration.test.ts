import { randomUUID } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { users, profiles, logtoAccountSecurity, eq } from "@nautilo/db";
import { setupOwnerAppFixture, seatPeerUser } from "./helpers/app-fixture";
import { authedInject } from "./helpers/request-helpers";

describe("admin users directory (D219 S4)", () => {
  test("owner can list/get/reset users; members are denied", async () => {
    const suiteName = `d219dir${randomUUID().slice(0, 6)}`;
    const fx = await setupOwnerAppFixture({ suiteName });
    let peerUserId: string | null = null;
    let federatedUserId: string | null = null;
    try {
      const ownerBearer = await fx.mintOwnerBearer();
      const peer = await seatPeerUser(fx.db, { suiteName, groupType: "members" });
      peerUserId = peer.userId;
      const [federated] = await fx.db
        .insert(users)
        .values({
          name: "Federated Stub",
          email: `${suiteName}-federated@test.local`,
          handle: `${suiteName}fed${Date.now().toString(36)}`,
          server: "remote.example",
        })
        .returning({ id: users.id });
      federatedUserId = federated?.id ?? null;

      const list = await authedInject(fx.app, {
        method: "GET",
        url: `/api/admin/users?search=${encodeURIComponent(suiteName)}`,
        bearer: ownerBearer,
      });
      expect(list.statusCode).toBe(200);
      const body = JSON.parse(list.body) as {
        users: Array<{ id: string; groups: unknown[]; serverRole?: unknown; server: string | null }>;
        nextCursor: string | null;
        page: { returned: number; complete: boolean; hasMore: boolean; nextCursor: string | null };
      };
      expect(body.users.some((u) => u.id === fx.ownerId)).toBe(true);
      expect(body.users.some((u) => u.id === peer.userId)).toBe(true);
      expect(body.users.some((u) => u.id === federatedUserId)).toBe(false);
      expect(body.page).toMatchObject({
        returned: body.users.length,
        complete: true,
        hasMore: false,
        nextCursor: null,
      });
      for (const row of body.users.filter((u) => u.id === fx.ownerId || u.id === peer.userId)) {
        expect(Array.isArray(row.groups)).toBe(true);
        expect("serverRole" in row).toBe(false);
      }

      const single = await authedInject(fx.app, {
        method: "GET",
        url: `/api/admin/users/${peer.userId}`,
        bearer: ownerBearer,
      });
      expect(single.statusCode).toBe(200);
      const singleBody = JSON.parse(single.body) as { id: string; groups: unknown[]; serverRole?: unknown };
      expect(singleBody.id).toBe(peer.userId);
      expect(Array.isArray(singleBody.groups)).toBe(true);
      expect("serverRole" in singleBody).toBe(false);

      const searched = await authedInject(fx.app, {
        method: "GET",
        url: `/api/admin/users?search=${encodeURIComponent(`${suiteName}-members-peer`)}&limit=1`,
        bearer: ownerBearer,
      });
      expect(searched.statusCode).toBe(200);
      const searchedUsers = (JSON.parse(searched.body) as { users: Array<{ id: string }> }).users;
      expect(searchedUsers).toHaveLength(1);
      expect(searchedUsers[0]?.id).toBe(peer.userId);

      for (const url of ["/api/admin/users?limit=0", "/api/admin/users?limit=1x", "/api/admin/users?cursor=not-a-cursor"]) {
        const invalid = await authedInject(fx.app, { method: "GET", url, bearer: ownerBearer });
        expect(invalid.statusCode).toBe(400);
      }

      const reset = await authedInject(fx.app, {
        method: "POST",
        url: `/api/admin/users/${peer.userId}/reset-password`,
        bearer: ownerBearer,
      });
      expect(reset.statusCode).toBe(200);
      const resetBody = JSON.parse(reset.body) as {
        ok: boolean;
        token: string;
        url: string;
        mutation: { stateChanged: boolean; retrySafe: boolean; receiptId: string };
      };
      expect(resetBody.ok).toBe(true);
      expect(resetBody.token).toBe("stub-ott");
      expect(resetBody.url).toContain("token=stub-ott");
      expect(resetBody.mutation).toMatchObject({
        stateChanged: true,
        retrySafe: false,
        receiptId: peer.userId,
      });

      await fx.db
        .update(users)
        .set({ email: null })
        .where(eq(users.id, peer.userId));
      const usernameReset = await authedInject(fx.app, {
        method: "POST",
        url: `/api/admin/users/${peer.userId}/reset-password`,
        bearer: ownerBearer,
      });
      expect(usernameReset.statusCode).toBe(200);
      const usernameResetBody = JSON.parse(usernameReset.body) as {
        ok: boolean;
        delivery: string;
        temporaryPassword: string;
        mustChangePassword: boolean;
        mutation: { retrySafe: boolean };
      };
      expect(usernameResetBody).toMatchObject({
        ok: true,
        delivery: "temporary_password",
        mustChangePassword: true,
        mutation: { retrySafe: true },
      });
      expect(usernameResetBody.temporaryPassword.length).toBeGreaterThanOrEqual(32);
      const [security] = await fx.db
        .select({ required: logtoAccountSecurity.requiresPasswordChange })
        .from(logtoAccountSecurity)
        .where(eq(logtoAccountSecurity.userId, peer.userId))
        .limit(1);
      expect(security?.required).toBe(true);

      for (const route of [
        { method: "GET" as const, url: "/api/admin/users" },
        { method: "GET" as const, url: `/api/admin/users/${fx.ownerId}` },
        { method: "POST" as const, url: `/api/admin/users/${fx.ownerId}/disable`, payload: {} },
        { method: "POST" as const, url: `/api/admin/users/${fx.ownerId}/enable`, payload: {} },
        { method: "POST" as const, url: `/api/admin/users/${fx.ownerId}/reset-password`, payload: {} },
      ]) {
        const denied = await authedInject(fx.app, {
          method: route.method,
          url: route.url,
          bearer: peer.bearer,
          payload: route.payload,
        });
        expect(denied.statusCode).toBe(403);
      }
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
