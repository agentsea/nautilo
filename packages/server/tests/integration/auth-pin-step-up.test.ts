/**
 * M101 / M102 — POST /api/auth/pin and POST /api/auth/recover accept a fresh
 * Logto JWT (`iat` within 60s) as an alternative to old PIN / recovery code.
 * M102: POST /api/auth/recover is not localhost-gated; fresh-JWT gates the
 * no-recovery-code path from any client IP.
 */
import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../../.env") });

import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
} from "bun:test";
import { setupOwnerAppFixture, type AppFixture } from "./helpers/app-fixture";

let fx: AppFixture;

beforeEach(async () => {
  fx = await setupOwnerAppFixture({ suiteName: `m101pin${Date.now().toString(36)}` });
});

afterEach(async () => {
  await fx.cleanup();
});

describe("POST /api/auth/pin (M101 step-up)", () => {
  test("401 fresh_reauth_required when enrolled, no currentPin, stale JWT", async () => {
    const stale = await fx.mintOwnerBearerIssuedAt(
      Math.floor(Date.now() / 1000) - 120,
    );
    const res = await fx.app.inject({
      method: "POST",
      url: "/api/auth/pin",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${stale}`,
      },
      payload: { newPin: "234567" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "fresh_reauth_required" });
  });

  test("200 when enrolled, no currentPin, fresh JWT — PIN updated", async () => {
    const fresh = await fx.mintOwnerBearer();
    const res = await fx.app.inject({
      method: "POST",
      url: "/api/auth/pin",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${fresh}`,
      },
      payload: { newPin: "234567" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
  });

  test("200 when valid currentPin even if JWT iat is stale", async () => {
    const stale = await fx.mintOwnerBearerIssuedAt(
      Math.floor(Date.now() / 1000) - 120,
    );
    const res = await fx.app.inject({
      method: "POST",
      url: "/api/auth/pin",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${stale}`,
      },
      payload: { currentPin: fx.ownerPin, newPin: "456789" },
    });
    expect(res.statusCode).toBe(200);
  });

  test("401 when currentPin invalid and JWT is stale", async () => {
    const stale = await fx.mintOwnerBearerIssuedAt(
      Math.floor(Date.now() / 1000) - 120,
    );
    const res = await fx.app.inject({
      method: "POST",
      url: "/api/auth/pin",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${stale}`,
      },
      payload: { currentPin: "000000", newPin: "567890" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "Current PIN is incorrect" });
  });
});

describe("POST /api/auth/recover (M101 step-up, M102 IP)", () => {
  test("200 with fresh JWT, no recoveryCode, localhost", async () => {
    const fresh = await fx.mintOwnerBearer();
    const res = await fx.app.inject({
      method: "POST",
      url: "/api/auth/recover",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${fresh}`,
      },
      payload: { newPin: "678901" },
      remoteAddress: "127.0.0.1",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      ok?: boolean;
      codesRemaining?: unknown;
    };
    expect(body.ok).toBe(true);
    expect(typeof body.codesRemaining).toBe("number");
  });

  test("200 with fresh JWT, no recoveryCode, non-localhost IP", async () => {
    const fresh = await fx.mintOwnerBearer();
    const res = await fx.app.inject({
      method: "POST",
      url: "/api/auth/recover",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${fresh}`,
      },
      payload: { newPin: "678902" },
      remoteAddress: "203.0.113.10",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      ok?: boolean;
      codesRemaining?: unknown;
    };
    expect(body.ok).toBe(true);
    expect(typeof body.codesRemaining).toBe("number");
  });

  test("401 with stale JWT, no recoveryCode, localhost", async () => {
    const stale = await fx.mintOwnerBearerIssuedAt(
      Math.floor(Date.now() / 1000) - 120,
    );
    const res = await fx.app.inject({
      method: "POST",
      url: "/api/auth/recover",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${stale}`,
      },
      payload: { newPin: "789012" },
      remoteAddress: "127.0.0.1",
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "fresh_reauth_required" });
  });

  test("401 fresh_reauth_required with stale JWT, no recoveryCode, non-localhost IP", async () => {
    const stale = await fx.mintOwnerBearerIssuedAt(
      Math.floor(Date.now() / 1000) - 120,
    );
    const res = await fx.app.inject({
      method: "POST",
      url: "/api/auth/recover",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${stale}`,
      },
      payload: { newPin: "789013" },
      remoteAddress: "203.0.113.10",
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "fresh_reauth_required" });
  });
});
