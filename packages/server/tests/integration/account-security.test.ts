/**
 * D104 — GET /api/account/security integration coverage (M072 Logto JWT).
 */
import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../.env") });

import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
} from "bun:test";
import { logtoAccountSecurity, eq } from "@nautilo/db";
import { setupOwnerAppFixture, type AppFixture } from "./helpers/app-fixture";

let fx: AppFixture;

beforeAll(async () => {
  fx = await setupOwnerAppFixture({ suiteName: "acctsec" });
  await fx.db.insert(logtoAccountSecurity).values({
    userId: fx.ownerId,
    requiresPasswordChange: true,
    passwordChangeReason: "migration_temp_password",
    requiredSince: new Date("2026-01-15T12:00:00.000Z"),
    completedAt: null,
    lastOperatorActorId: null,
  });
});

afterAll(async () => {
  await fx.db.delete(logtoAccountSecurity).where(eq(logtoAccountSecurity.userId, fx.ownerId));
  await fx.cleanup();
});

describe("GET /api/account/security", () => {
  test("401 without session", async () => {
    const res = await fx.app.inject({ method: "GET", url: "/api/account/security" });
    expect(res.statusCode).toBe(401);
  });

  test("200 returns linked Logto state + requiresPasswordChange", async () => {
    const bearer = await fx.mintOwnerBearer();
    const res = await fx.app.inject({
      method: "GET",
      url: "/api/account/security",
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      linkedToLogto?: boolean;
      requiresPasswordChange?: boolean;
      passwordChangeReason?: string | null;
      logtoRecoveryCodes?: { remaining: number; total: number; lastGeneratedAt: string | null };
    };
    expect(body.linkedToLogto).toBe(true);
    expect(body.requiresPasswordChange).toBe(true);
    expect(body.passwordChangeReason).toBe("migration_temp_password");
    expect(body.logtoRecoveryCodes).toEqual({
      remaining: 0,
      total: 0,
      lastGeneratedAt: null,
    });
  });

  test("restricted identity can inspect itself but cannot reach ordinary admin APIs", async () => {
    const bearer = await fx.mintOwnerBearer();
    const whoami = await fx.app.inject({
      method: "GET",
      url: "/api/auth/whoami",
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(whoami.statusCode).toBe(200);
    expect(JSON.parse(whoami.body)).toMatchObject({ mustChangePassword: true });

    const denied = await fx.app.inject({
      method: "GET",
      url: "/api/admin/users",
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(denied.statusCode).toBe(403);
    expect(JSON.parse(denied.body)).toMatchObject({ code: "password_change_required" });
  });
});

describe("POST /api/account/password/change", () => {
  test("401 without session", async () => {
    const res = await fx.app.inject({
      method: "POST",
      url: "/api/account/password/change",
      headers: { "content-type": "application/json" },
      payload: {
        currentPassword: "old",
        newPassword: "new-password-9",
      },
    });
    expect(res.statusCode).toBe(401);
  });

  test("authenticated request is not rejected as unauthenticated (upstream may 502)", async () => {
    const bearer = await fx.mintOwnerBearer();
    const res = await fx.app.inject({
      method: "POST",
      url: "/api/account/password/change",
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
      },
      payload: {
        currentPassword: "old",
        newPassword: "new-password-9",
      },
    });
    expect(res.statusCode).not.toBe(401);
    expect([200, 400, 422, 502]).toContain(res.statusCode);
  });
});
