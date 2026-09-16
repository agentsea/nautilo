import { describe, expect, test } from "bun:test";
import {
  eq,
  getAccountSecurityRowByUserId,
  groupMembers,
  groups,
  markPasswordChangeRequired,
  PASSWORD_CHANGE_REASON,
  users,
} from "@nautilo/db";
import { setupOwnerAppFixture } from "./helpers/app-fixture";
import { authedInject } from "./helpers/request-helpers";

describe("direct member provisioning", () => {
  test("owner provisions once, receives one credential handoff, and retries by receipt", async () => {
    const priorSecret = process.env["NAUTILO_PROVISIONING_IDEMPOTENCY_SECRET"];
    process.env["NAUTILO_PROVISIONING_IDEMPOTENCY_SECRET"] = "integration-only-provisioning-secret";
    const fx = await setupOwnerAppFixture({ suiteName: "d518provision" });
    let memberId: string | null = null;
    try {
      const bearer = await fx.mintOwnerBearer();
      const handle = `d518p${Date.now().toString(36).slice(-8)}`;
      const payload = {
        handle,
        displayName: "Provisioned Person",
        roleSlug: "member",
      };
      const headers = { "idempotency-key": `d518-provision-${crypto.randomUUID()}` };
      const secretBearing = await authedInject(fx.app, {
        method: "POST",
        url: "/api/admin/users/provision",
        bearer,
        payload: { ...payload, password: "operator-must-not-supply-this" },
        headers: { "idempotency-key": `d518-rejected-${crypto.randomUUID()}` },
      });
      expect(secretBearing.statusCode).toBe(400);
      expect(JSON.parse(secretBearing.body)).toMatchObject({ code: "invalid_provision_intent" });

      const created = await authedInject(fx.app, {
        method: "POST",
        url: "/api/admin/users/provision",
        bearer,
        payload,
        headers,
      });
      expect(created.statusCode).toBe(200);
      const body = JSON.parse(created.body) as {
        receiptId: string;
        memberId: string;
        idempotent: boolean;
        credential: {
          disposition: string;
          temporaryPassword: string;
          pin: string;
          recoveryCodes: string[];
        };
      };
      memberId = body.memberId;
      expect(body.idempotent).toBe(false);
      expect(body.credential.disposition).toBe("issued");
      expect(body.credential.temporaryPassword.length).toBeGreaterThan(32);
      expect(body.credential.pin).toMatch(/^\d{6}$/u);
      expect(body.credential.recoveryCodes.length).toBeGreaterThan(0);

      const security = await getAccountSecurityRowByUserId(fx.db, memberId);
      expect(security?.requiresPasswordChange).toBe(true);
      const membership = await fx.db
        .select({ type: groups.type })
        .from(groupMembers)
        .innerJoin(groups, eq(groups.id, groupMembers.groupId))
        .where(eq(groupMembers.userId, memberId));
      expect(membership.map((row) => row.type)).toContain("members");

      const duplicateHandle = await authedInject(fx.app, {
        method: "POST",
        url: "/api/admin/users/provision",
        bearer,
        payload,
        headers: { "idempotency-key": `d518-duplicate-${crypto.randomUUID()}` },
      });
      expect(duplicateHandle.statusCode).toBe(409);
      const duplicateRows = await fx.db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.handle, handle));
      expect(duplicateRows).toHaveLength(1);

      const ownerEscalation = await authedInject(fx.app, {
        method: "POST",
        url: "/api/admin/users/provision",
        bearer,
        payload: { ...payload, handle: `${handle}x`, roleSlug: "owner" },
        headers: { "idempotency-key": `d518-owner-${crypto.randomUUID()}` },
      });
      expect(ownerEscalation.statusCode).toBe(400);

      const repeated = await authedInject(fx.app, {
        method: "POST",
        url: "/api/admin/users/provision",
        bearer,
        payload,
        headers,
      });
      expect(repeated.statusCode).toBe(200);
      expect(JSON.parse(repeated.body)).toMatchObject({
        receiptId: body.receiptId,
        memberId,
        idempotent: true,
        credential: { disposition: "not_reissued" },
      });

      const collision = await authedInject(fx.app, {
        method: "POST",
        url: "/api/admin/users/provision",
        bearer,
        payload: { ...payload, displayName: "Changed Intent" },
        headers,
      });
      expect(collision.statusCode).toBe(409);
      expect(JSON.parse(collision.body)).toMatchObject({ code: "idempotency_conflict" });
    } finally {
      if (memberId) {
        const bearer = await fx.mintOwnerBearer();
        await authedInject(fx.app, {
          method: "DELETE",
          url: `/api/admin/users/${memberId}`,
          bearer,
        });
        await fx.db.delete(users).where(eq(users.id, memberId));
      }
      await fx.cleanup();
      if (priorSecret === undefined) {
        delete process.env["NAUTILO_PROVISIONING_IDEMPOTENCY_SECRET"];
      } else {
        process.env["NAUTILO_PROVISIONING_IDEMPOTENCY_SECRET"] = priorSecret;
      }
    }
  });

  test("permanent provisioning and restoration never require password rotation", async () => {
    const priorSecret = process.env["NAUTILO_PROVISIONING_IDEMPOTENCY_SECRET"];
    process.env["NAUTILO_PROVISIONING_IDEMPOTENCY_SECRET"] = "integration-only-provisioning-secret";
    const fx = await setupOwnerAppFixture({ suiteName: "d518permanent" });
    let memberId: string | null = null;
    try {
      const bearer = await fx.mintOwnerBearer();
      const handle = `d518d${Date.now().toString(36).slice(-8)}`;
      const password = `N!${crypto.randomUUID()}${crypto.randomUUID()}`;
      const created = await authedInject(fx.app, {
        method: "POST",
        url: "/api/admin/users/provision",
        bearer,
        payload: {
          handle,
          displayName: "Durable Reviewer",
          roleSlug: "member",
          permanentCredential: { password, pin: "654321" },
        },
        headers: { "idempotency-key": `d518-permanent-${crypto.randomUUID()}` },
      });
      expect(created.statusCode).toBe(200);
      memberId = (JSON.parse(created.body) as { memberId: string }).memberId;
      expect((await getAccountSecurityRowByUserId(fx.db, memberId))?.requiresPasswordChange)
        .not.toBe(true);

      await markPasswordChangeRequired(fx.db, {
        userId: memberId,
        reason: PASSWORD_CHANGE_REASON.SETUP_TEMP_PASSWORD,
      });
      expect((await getAccountSecurityRowByUserId(fx.db, memberId))?.requiresPasswordChange)
        .toBe(true);

      const restored = await authedInject(fx.app, {
        method: "PUT",
        url: `/api/admin/users/${memberId}/permanent-credentials`,
        bearer,
        payload: { password, pin: "654321" },
      });
      expect(restored.statusCode).toBe(200);
      expect(JSON.parse(restored.body)).toMatchObject({ ok: true, memberId });
      expect((await getAccountSecurityRowByUserId(fx.db, memberId))?.requiresPasswordChange)
        .toBe(false);
    } finally {
      if (memberId) await fx.db.delete(users).where(eq(users.id, memberId));
      await fx.cleanup();
      if (priorSecret === undefined) delete process.env["NAUTILO_PROVISIONING_IDEMPOTENCY_SECRET"];
      else process.env["NAUTILO_PROVISIONING_IDEMPOTENCY_SECRET"] = priorSecret;
    }
  });
});
