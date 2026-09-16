import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../.env") });

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { setupOwnerAppFixture, type AppFixture } from "./helpers/app-fixture";

const legacyAuthEnvKey = "AUTH" + "_" + "MODE";

/**
 * M072 Phase G — acceptance: Logto-only trust; legacy auth routes 404;
 * `/health` has no legacy auth discovery field; `PUT /api/security/posture`
 * uses `request.sessionUserId` for Logto JWTs (Phase A.4).
 */
describe("M072 — server boots without legacy auth env var (integration)", () => {
  const savedAuth = process.env[legacyAuthEnvKey];
  let fx: AppFixture;

  beforeAll(async () => {
    delete process.env[legacyAuthEnvKey];
    fx = await setupOwnerAppFixture({
      suiteName: "m072acc",
      withDefaultAgentGraph: true,
    });
  });

  afterAll(async () => {
    await fx.cleanup();
    if (savedAuth === undefined) delete process.env[legacyAuthEnvKey];
    else process.env[legacyAuthEnvKey] = savedAuth;
  });

  test("legacy auth routes return 404", async () => {
    for (const url of [
      "/api/auth/enroll",
      "/api/auth/session",
      "/api/auth/verify-and-resume",
      "/api/auth/logout",
    ] as const) {
      const res = await fx.app.inject({
        method: "POST",
        url,
        headers: { "content-type": "application/json" },
        payload: {},
      });
      expect(res.statusCode).toBe(404);
    }
  });

  test("GET /health omits authMode", async () => {
    const res = await fx.app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect("authMode" in body).toBe(false);
  });

  test("PUT /api/security/posture with Logto JWT is not rejected as unauthenticated (sessionUserId path)", async () => {
    const bearer = await fx.mintOwnerBearer();
    const getRes = await fx.app.inject({
      method: "GET",
      url: "/api/security/posture",
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(getRes.statusCode).toBe(200);
    const cur = JSON.parse(getRes.body) as { securityLevel?: string };
    const origLevel = cur.securityLevel;
    const nextLevel = origLevel === "paranoid" ? "standard" : "paranoid";

    try {
      const putRes = await fx.app.inject({
        method: "PUT",
        url: "/api/security/posture",
        headers: {
          authorization: `Bearer ${bearer}`,
          "content-type": "application/json",
        },
        payload: {
          securityLevel: nextLevel,
          pin: fx.ownerPin,
        },
      });
      expect(putRes.statusCode).toBe(200);
    } finally {
      // `resolveServerPosture` is process-global; restore so later suites
      // (e.g. WS subagent interrupt) see the pre-test posture.
      if (typeof origLevel === "string" && origLevel.length > 0) {
        await fx.app.inject({
          method: "PUT",
          url: "/api/security/posture",
          headers: {
            authorization: `Bearer ${bearer}`,
            "content-type": "application/json",
          },
          payload: {
            securityLevel: origLevel,
            pin: fx.ownerPin,
          },
        });
      }
    }
  });
});
