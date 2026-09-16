import { afterEach, describe, expect, mock, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import {
  MOBILE_USER_AGREEMENT_VERSION,
  MOBILE_USER_AGREEMENT_VERSIONS,
  type MobileUserAgreementStateResponse,
} from "@nautilo/types";

import { mobileUserAgreementRoutes } from "../../src/routes/mobile-user-agreement";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ACCEPTED_AT = "2026-08-27T12:00:00.000Z";
const apps: FastifyInstance[] = [];

const missing: MobileUserAgreementStateResponse = {
  current: MOBILE_USER_AGREEMENT_VERSIONS,
  accepted: false,
  acceptance: null,
};

const accepted: MobileUserAgreementStateResponse = {
  current: MOBILE_USER_AGREEMENT_VERSIONS,
  accepted: true,
  acceptance: {
    ...MOBILE_USER_AGREEMENT_VERSIONS,
    acceptedAt: ACCEPTED_AT,
    withdrawnAt: null,
  },
};

function makeApp(
  userId: string | null,
  deps: Parameters<typeof mobileUserAgreementRoutes>[1],
): FastifyInstance {
  const app = Fastify({ logger: false });
  app.decorateRequest("sessionUserId", null);
  app.addHook("preHandler", async (request) => {
    request.sessionUserId = userId;
  });
  mobileUserAgreementRoutes(app, deps);
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("Mobile user agreement routes", () => {
  test("reads, accepts, and withdraws only for the authenticated Human", async () => {
    const read = mock(async (_userId: string) => missing);
    const accept = mock(async (_userId: string) => accepted);
    const withdraw = mock(async (_userId: string) => missing);
    const app = makeApp(USER_ID, { read, accept, withdraw });

    const initial = await app.inject({ method: "GET", url: "/api/mobile-user-agreement" });
    expect(initial.statusCode).toBe(200);
    expect(initial.json<MobileUserAgreementStateResponse>()).toEqual(missing);
    expect(read).toHaveBeenCalledWith(USER_ID);

    const grant = await app.inject({
      method: "PUT",
      url: "/api/mobile-user-agreement",
      payload: { agreementVersion: MOBILE_USER_AGREEMENT_VERSION, userId: "attacker" },
    });
    expect(grant.statusCode).toBe(200);
    expect(grant.json<MobileUserAgreementStateResponse>()).toEqual(accepted);
    expect(accept).toHaveBeenCalledWith(USER_ID);

    const revoke = await app.inject({ method: "DELETE", url: "/api/mobile-user-agreement" });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json<MobileUserAgreementStateResponse>()).toEqual(missing);
    expect(withdraw).toHaveBeenCalledWith(USER_ID);
  });

  test("rejects unauthenticated callers and stale agreement versions", async () => {
    const unauthenticated = makeApp(null, {});
    for (const method of ["GET", "PUT", "DELETE"] as const) {
      const response = await unauthenticated.inject({
        method,
        url: "/api/mobile-user-agreement",
        ...(method === "PUT" ? { payload: { agreementVersion: MOBILE_USER_AGREEMENT_VERSION } } : {}),
      });
      expect(response.statusCode).toBe(401);
    }

    const accept = mock(async (_userId: string) => accepted);
    const authenticated = makeApp(USER_ID, { accept });
    const stale = await authenticated.inject({
      method: "PUT",
      url: "/api/mobile-user-agreement",
      payload: { agreementVersion: "mobile-user-agreement-old" },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({
      code: "mobile_user_agreement_version_mismatch",
      currentAgreementVersion: MOBILE_USER_AGREEMENT_VERSION,
    });
    expect(accept).not.toHaveBeenCalled();
  });
});
