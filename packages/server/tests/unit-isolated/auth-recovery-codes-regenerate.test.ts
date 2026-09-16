/**
 * Local/PIN recovery-code regeneration requires fresh PIN proof.
 * M077 — recovery routes use authenticated non-guest gate (same bar as POST /api/auth/pin).
 */
import { beforeEach, describe, expect, mock, test, afterAll } from "bun:test";
import Fastify from "fastify";

const regenerateRecoveryCodes = mock(async () => ["fresh-code"]);
const getRecoveryCodeStatus = mock(async (_userId: string) => ({
  total: 10,
  used: 0,
  remaining: 10,
}));

mock.module("@nautilo/trust", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const trust = require("@nautilo/trust") as Record<string, unknown>;
  return {
    ...trust,
    regenerateRecoveryCodes,
    getRecoveryCodeStatus,
  };
});

import { authRoutes } from "../../src/routes/auth";
import { SessionStore } from "../helpers/test-session-store";
import { installLocalAuthPreHandlerStub } from "../unit/helpers/auth-preHandler-stub";

const OWNER_ACTOR_ID = "owner-actor-id";
const OWNER_ID = "owner-user-id";
const HOUSEHOLD_USER_ID = "household-user-id";
const HOUSEHOLD_ACTOR_ID = "household-actor-id";

function makeOwnerApp() {
  const sessionStore = new SessionStore(undefined, { persistPath: null });
  const app = Fastify({ logger: false });
  installLocalAuthPreHandlerStub(app, sessionStore);
  const verifyProof = mock(async (_userId: string, pin: string) => pin === "918273");
  const pinProvider = {
    verifyProof,
  };
  authRoutes(app, {
    pinProvider: pinProvider as never,
    ownerActorId: OWNER_ACTOR_ID,
    ownerId: OWNER_ID,
  });
  const session = sessionStore.createSession(OWNER_ACTOR_ID, OWNER_ID, OWNER_ID);
  return { app, token: session.token, verifyProof };
}

function makeHouseholdMemberApp() {
  const sessionStore = new SessionStore(undefined, { persistPath: null });
  const app = Fastify({ logger: false });
  installLocalAuthPreHandlerStub(app, sessionStore, {
    policyRoleForSession(session) {
      return session.userId === HOUSEHOLD_USER_ID ? "household" : "owner";
    },
  });
  const verifyProof = mock(async (userId: string, pin: string) => {
    if (userId !== HOUSEHOLD_USER_ID) return false;
    return pin === "918273";
  });
  const pinProvider = {
    verifyProof,
  };
  authRoutes(app, {
    pinProvider: pinProvider as never,
    ownerActorId: OWNER_ACTOR_ID,
    ownerId: OWNER_ID,
  });
  const session = sessionStore.createSession(
    HOUSEHOLD_ACTOR_ID,
    OWNER_ID,
    HOUSEHOLD_USER_ID,
  );
  return { app, token: session.token, verifyProof };
}

beforeEach(() => {
  regenerateRecoveryCodes.mockClear();
  getRecoveryCodeStatus.mockClear();
});

describe("GET /api/auth/recovery-codes/status", () => {
  test("returns status for owner session", async () => {
    const { app, token } = makeOwnerApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/auth/recovery-codes/status",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(getRecoveryCodeStatus).toHaveBeenCalledWith(OWNER_ID);
      expect(JSON.parse(res.body)).toEqual({ total: 10, used: 0, remaining: 10 });
    } finally {
      await app.close();
    }
  });

  test("returns status for authenticated household member (not deployment owner role)", async () => {
    const { app, token } = makeHouseholdMemberApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/auth/recovery-codes/status",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(getRecoveryCodeStatus).toHaveBeenCalledWith(HOUSEHOLD_USER_ID);
    } finally {
      await app.close();
    }
  });

  test("rejects unauthenticated requests", async () => {
    const { app } = makeOwnerApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/auth/recovery-codes/status",
      });
      expect(res.statusCode).toBe(401);
      expect(getRecoveryCodeStatus).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

describe("POST /api/auth/recovery-codes/regenerate", () => {
  test("rejects bearer-only regeneration without PIN reverify", async () => {
    const { app, token, verifyProof } = makeOwnerApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/recovery-codes/regenerate",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      expect(verifyProof).not.toHaveBeenCalled();
      expect(regenerateRecoveryCodes).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test("regenerates after PIN reverify", async () => {
    const { app, token, verifyProof } = makeOwnerApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/recovery-codes/regenerate",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        payload: { pin: "918273" },
      });
      expect(res.statusCode).toBe(200);
      expect(verifyProof).toHaveBeenCalledWith(OWNER_ID, "918273");
      expect(regenerateRecoveryCodes).toHaveBeenCalledWith(OWNER_ID);
      expect(JSON.parse(res.body)).toEqual({ recoveryCodes: ["fresh-code"] });
    } finally {
      await app.close();
    }
  });

  test("household member can regenerate own codes after PIN reverify", async () => {
    const { app, token, verifyProof } = makeHouseholdMemberApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/recovery-codes/regenerate",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        payload: { pin: "918273" },
      });
      expect(res.statusCode).toBe(200);
      expect(verifyProof).toHaveBeenCalledWith(HOUSEHOLD_USER_ID, "918273");
      expect(regenerateRecoveryCodes).toHaveBeenCalledWith(HOUSEHOLD_USER_ID);
    } finally {
      await app.close();
    }
  });
});

afterAll(() => {
  mock.restore();
});
