import { describe, expect, test } from "bun:test";
import { eq, groups, profiles, users } from "@nautilo/db";
import { setupOwnerAppFixture, seatPeerUser } from "./helpers/app-fixture";
import { authedInject } from "./helpers/request-helpers";

describe("admin promotion via groups (D219 S6)", () => {
  test(
    "admins group membership grants and revokes admin REST access",
    async () => {
    const fx = await setupOwnerAppFixture({ suiteName: "d219prom" });
    let peerUserId: string | null = null;
    try {
      const ownerBearer = await fx.mintOwnerBearer();
      const peer = await seatPeerUser(fx.db, { suiteName: "d219prom", groupType: "members" });
      peerUserId = peer.userId;

      const before = await authedInject(fx.app, {
        method: "GET",
        url: "/api/admin/users",
        bearer: peer.bearer,
      });
      expect(before.statusCode).toBe(403);

      const groupsRes = await authedInject(fx.app, {
        method: "GET",
        url: "/api/groups",
        bearer: ownerBearer,
      });
      expect(groupsRes.statusCode).toBe(200);
      const groupsBody = JSON.parse(groupsRes.body) as {
        groups: Array<{ id: string; type: string }>;
      };
      const adminsGroup = groupsBody.groups.find((g) => g.type === "admins");
      expect(adminsGroup).toBeDefined();

      // D418 regression guard: the canonical `admins` Group is
      // system-managed (is_system=true, owner_id NULL). Legitimate
      // membership administration of canonical ladder Groups must
      // remain green despite the system-managed discriminator.
      const [adminsRow] = await fx.db
        .select({ isSystem: groups.isSystem, ownerId: groups.ownerId })
        .from(groups)
        .where(eq(groups.id, adminsGroup!.id))
        .limit(1);
      expect(adminsRow?.isSystem).toBe(true);
      expect(adminsRow?.ownerId).toBeNull();

      const promote = await authedInject(fx.app, {
        method: "PUT",
        url: `/api/groups/${adminsGroup?.id}/members/${peer.userId}`,
        bearer: ownerBearer,
      });
      expect(promote.statusCode).toBe(200);

      const afterPromote = await authedInject(fx.app, {
        method: "GET",
        url: "/api/admin/users",
        bearer: peer.bearer,
      });
      expect(afterPromote.statusCode).toBe(200);

      const demote = await authedInject(fx.app, {
        method: "DELETE",
        url: `/api/groups/${adminsGroup?.id}/members/${peer.userId}`,
        bearer: ownerBearer,
      });
      expect(demote.statusCode).toBe(200);

      const afterDemote = await authedInject(fx.app, {
        method: "GET",
        url: "/api/admin/users",
        bearer: peer.bearer,
      });
      expect(afterDemote.statusCode).toBe(403);
    } finally {
      if (peerUserId) {
        await fx.db.delete(profiles).where(eq(profiles.userId, peerUserId));
        await fx.db.delete(users).where(eq(users.id, peerUserId));
      }
      await fx.cleanup();
    }
  },
    60000,
  );
});
