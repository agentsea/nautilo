/**
 * M128 TP11 — server invite ladder coverage via mint + redeem.
 */
import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../.env") });

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { eq, groupMembers, groups } from "@nautilo/db";
import { M128_ROLE_CAPABILITIES } from "@nautilo/db";
import { getUserCapabilities, findUserHighestRoleSlug } from "@nautilo/trust";
import { setupOwnerAppFixture, type AppFixture } from "./helpers/app-fixture";
import { authedInject } from "./helpers/request-helpers";
import {
  redeemServerInviteToken,
  cleanupInvitee,
} from "./helpers/invite-redeem-helpers";

const LADDER = [
  { roleSlug: "owner", groupType: "owners" },
  { roleSlug: "admin", groupType: "admins" },
  { roleSlug: "superuser", groupType: "superusers" },
  { roleSlug: "member", groupType: "members" },
  { roleSlug: "contributor", groupType: "contributors" },
  { roleSlug: "guest", groupType: "guests" },
] as const;

describe("POST /api/invites — M128 ladder coverage (TP11)", () => {
  let fx: AppFixture;
  let bearer: string;

  beforeAll(async () => {
    fx = await setupOwnerAppFixture({ suiteName: "m128tp11" });
    bearer = await fx.mintOwnerBearer();
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  for (const rung of LADDER) {
    test(`kind=server targetGroupRoleSlug=${rung.roleSlug} lands in ${rung.groupType} with expected caps`, async () => {
      const mintRes = await authedInject(fx.app, {
        method: "POST",
        url: "/api/invites",
        bearer,
        payload: { kind: "server", targetGroupRoleSlug: rung.roleSlug },
      });
      expect(mintRes.statusCode).toBe(200);
      const mintBody = JSON.parse(mintRes.body) as { token?: string };
      expect(typeof mintBody.token).toBe("string");

      const handle = `tp11${rung.roleSlug}${Date.now().toString(36).slice(-6)}`;
      const redeem = await redeemServerInviteToken(mintBody.token!, handle);
      expect(redeem.ok).toBe(true);
      if (!redeem.ok) return;

      const [gm] = await fx.db
        .select({ groupType: groups.type })
        .from(groupMembers)
        .innerJoin(groups, eq(groupMembers.groupId, groups.id))
        .where(eq(groupMembers.userId, redeem.newUserId))
        .limit(1);
      expect(gm?.groupType).toBe(rung.groupType);

      const caps = new Set(await getUserCapabilities(redeem.newUserId));
      const expected = new Set(M128_ROLE_CAPABILITIES[rung.roleSlug] ?? []);
      // Compare against the CANONICAL capability universe only (owner's
      // bundle == every canonical slug). A non-fresh operator DB can carry
      // retired-but-undropped capability rows (a previously upgraded database may have
      // `write_shared_memory` / `approve_shared_memory`, retired in M129),
      // which the owner Role — granted "all caps that exist" — would pick
      // up, inflating the raw count. Intersecting with the canonical
      // universe keeps the assertion exact for the role's real bundle
      // while staying resilient to extra rows the DB happens to hold.
      const canonicalUniverse = new Set(M128_ROLE_CAPABILITIES["owner"] ?? []);
      const effective = new Set([...caps].filter((c) => canonicalUniverse.has(c)));
      expect(effective.size).toBe(expected.size);
      for (const slug of expected) {
        expect(caps.has(slug)).toBe(true);
      }

      expect(await findUserHighestRoleSlug(redeem.newUserId)).toBe(rung.roleSlug);

      await cleanupInvitee(fx, redeem.newUserId);
    });
  }
});
