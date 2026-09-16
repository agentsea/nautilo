import { describe, expect, test } from "bun:test";
import { eq, memberRollouts, users } from "@nautilo/db";
import { setupOwnerAppFixture } from "./helpers/app-fixture";
import { authedInject } from "./helpers/request-helpers";

describe("member rollout planning", () => {
  test("returns a server-bound, write-free plan and rejects secret-bearing manifests", async () => {
    const fx = await setupOwnerAppFixture({ suiteName: "d518rolloutplan" });
    try {
      const bearer = await fx.mintOwnerBearer();
      const before = await fx.db.select({ id: users.id }).from(users);
      const handle = `d518r${Date.now().toString(36).slice(-8)}`;
      const payload = {
        schemaVersion: 1,
        members: [{ handle, displayName: "Rollout Person", roleSlug: "member" }],
      };

      const planned = await authedInject(fx.app, {
        method: "POST",
        url: "/api/admin/users/rollout/plan",
        bearer,
        payload,
      });
      expect(planned.statusCode).toBe(200);
      const plan = JSON.parse(planned.body) as {
        fingerprint: string;
        serverInstanceId: string;
        operations: Array<{ handle: string; roleSlug: string }>;
      };
      expect(plan.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
      expect(plan.serverInstanceId.length).toBeGreaterThan(0);
      expect(plan.operations).toHaveLength(1);
      expect(plan.operations[0]).toMatchObject({ handle, roleSlug: "member" });
      const after = await fx.db.select({ id: users.id }).from(users);
      expect(after.map((row) => row.id).sort()).toEqual(before.map((row) => row.id).sort());

      const forbidden = await authedInject(fx.app, {
        method: "POST",
        url: "/api/admin/users/rollout/plan",
        bearer,
        payload: { ...payload, metadata: { temporaryPassword: "must-never-enter-a-plan" } },
      });
      expect(forbidden.statusCode).toBe(400);
      expect(JSON.parse(forbidden.body)).toEqual({ code: "secret_field_forbidden" });
    } finally {
      await fx.cleanup();
    }
  });

  test("applies once, exposes durable status without secrets, acknowledges custody, and deduplicates", async () => {
    const priorSecret = process.env["NAUTILO_PROVISIONING_IDEMPOTENCY_SECRET"];
    process.env["NAUTILO_PROVISIONING_IDEMPOTENCY_SECRET"] = "integration-only-rollout-secret";
    const fx = await setupOwnerAppFixture({
      suiteName: `d518ra${crypto.randomUUID().slice(0, 6)}`,
    });
    let memberId: string | null = null;
    let bearer: string | null = null;
    try {
      bearer = await fx.mintOwnerBearer();
      const handle = `d518a${Date.now().toString(36).slice(-8)}`;
      const manifest = {
        schemaVersion: 1,
        members: [{ handle, displayName: "Applied Person", roleSlug: "member" }],
      };
      const planned = await authedInject(fx.app, {
        method: "POST",
        url: "/api/admin/users/rollout/plan",
        bearer,
        payload: manifest,
      });
      const fingerprint = (JSON.parse(planned.body) as { fingerprint: string }).fingerprint;
      const idempotencyKey = `d518-rollout-${crypto.randomUUID()}`;
      const applied = await authedInject(fx.app, {
        method: "POST",
        url: "/api/admin/users/rollout/apply",
        bearer,
        headers: { "idempotency-key": idempotencyKey },
        payload: { manifest, fingerprint },
      });
      expect(applied.statusCode).toBe(200);
      const body = JSON.parse(applied.body) as {
        rolloutId: string;
        items: Array<{ memberId: string | null; state: string }>;
        credentials: Array<{ temporaryPassword: string; pin: string; recoveryCodes: string[] }>;
      };
      memberId = body.items[0]?.memberId ?? null;
      expect(body.items[0]?.state).toBe("nautilo_committed");
      expect(body.credentials[0]?.temporaryPassword.length).toBeGreaterThan(32);

      const status = await authedInject(fx.app, {
        method: "GET",
        url: `/api/admin/users/rollout/${body.rolloutId}`,
        bearer,
      });
      expect(status.statusCode).toBe(200);
      expect(status.body).not.toContain(body.credentials[0]?.temporaryPassword ?? "canary");
      expect(JSON.parse(status.body)).not.toHaveProperty("credentials");

      const acknowledged = await authedInject(fx.app, {
        method: "POST",
        url: `/api/admin/users/rollout/${body.rolloutId}/acknowledge`,
        bearer,
        payload: { sequences: [0] },
      });
      expect(JSON.parse(acknowledged.body)).toMatchObject({
        status: "complete",
        items: [{ state: "complete", credentialDisposition: "issued" }],
      });

      const repeated = await authedInject(fx.app, {
        method: "POST",
        url: "/api/admin/users/rollout/apply",
        bearer,
        headers: { "idempotency-key": idempotencyKey },
        payload: { manifest, fingerprint },
      });
      expect(JSON.parse(repeated.body)).toMatchObject({
        rolloutId: body.rolloutId,
        idempotent: true,
        credentials: [],
      });
    } finally {
      if (memberId && bearer) {
        await authedInject(fx.app, {
          method: "DELETE",
          url: `/api/admin/users/${memberId}`,
          bearer,
        });
      }
      await fx.db.delete(memberRollouts).where(eq(memberRollouts.createdBy, fx.ownerId));
      await fx.cleanup();
      if (priorSecret === undefined) delete process.env["NAUTILO_PROVISIONING_IDEMPOTENCY_SECRET"];
      else process.env["NAUTILO_PROVISIONING_IDEMPOTENCY_SECRET"] = priorSecret;
    }
  });
});
