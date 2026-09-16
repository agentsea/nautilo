/**
 * The server integration runner executes every file in its own Bun process,
 * which contains this file's sticky `mock.module("@nautilo/trust", …)`.
 */
/**
 * D104 — Logto recovery-code regeneration must require fresh reverify.
 * Uses real Postgres (`createDirectDb`) so `@nautilo/db` is never stubbed with fake
 * Drizzle chains — only `@nautilo/trust` is mocked (spread real exports + overrides).
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import Fastify from "fastify";
import { createDirectDb, ensureDatabase, users, eq } from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import type { PinChallengeProvider } from "@nautilo/trust";
import { accountRoutes } from "../../src/routes/account";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const LOGTO_USER_ID = "logto-user-1";

const verifyUserPassword = mock(async () => true);
const regenerateLogtoAccountRecoveryCodes = mock(async () => [
  "code-one",
  "code-two",
]);

let poolDb: ReturnType<typeof createDirectDb>;
let hookAccessTokenIssuedAt: number | null = null;

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  poolDb = createDirectDb(1);
  await poolDb.delete(users).where(eq(users.id, USER_ID));
  await poolDb.insert(users).values({
    id: USER_ID,
    name: "D104 account recovery unit",
    email: "d104-account-recovery@test.local",
    handle: "d104acctrecv",
    externalId: LOGTO_USER_ID,
  });
});

beforeEach(async () => {
  hookAccessTokenIssuedAt = null;
  mock.restore();
  const realTrustAcct = await import("@nautilo/trust");
  mock.module("@nautilo/trust", () => ({
    ...realTrustAcct,
    getLogtoAdminClient: () => ({ verifyUserPassword }),
    getLogtoAccountRecoveryCodeStatus: async () => ({
      remaining: 0,
      total: 0,
      lastGeneratedAt: null,
    }),
    regenerateLogtoAccountRecoveryCodes,
  }));
  verifyUserPassword.mockClear();
  verifyUserPassword.mockImplementation(async () => true);
  regenerateLogtoAccountRecoveryCodes.mockClear();
});

afterEach(() => {
  mock.restore();
});

afterAll(async () => {
  await poolDb.delete(users).where(eq(users.id, USER_ID));
  await poolDb.end();
});

function makeApp(deps?: { pinProvider?: PinChallengeProvider }) {
  const app = Fastify({ logger: false });
  app.decorateRequest("sessionUserId", null);
  app.decorateRequest("accessTokenIssuedAt", null);
  app.addHook("preHandler", async (request) => {
    request.sessionUserId = USER_ID;
    request.accessTokenIssuedAt = hookAccessTokenIssuedAt;
  });
  accountRoutes(app, deps);
  return app;
}

describe("POST /api/account/recovery-codes/regenerate", () => {
  test("succeeds with fresh access token and no PIN", async () => {
    hookAccessTokenIssuedAt = Math.floor(Date.now() / 1000) - 60;
    const app = makeApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/account/recovery-codes/regenerate",
        headers: { "content-type": "application/json" },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect(regenerateLogtoAccountRecoveryCodes).toHaveBeenCalledWith(USER_ID);
      expect(JSON.parse(res.body)).toEqual({
        recoveryCodes: ["code-one", "code-two"],
      });
    } finally {
      await app.close();
    }
  });

  test("401 fresh_reauth_required when token is stale and no PIN", async () => {
    hookAccessTokenIssuedAt = Math.floor(Date.now() / 1000) - 600;
    const app = makeApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/account/recovery-codes/regenerate",
        headers: { "content-type": "application/json" },
        payload: {},
      });
      expect(res.statusCode).toBe(401);
      expect(regenerateLogtoAccountRecoveryCodes).not.toHaveBeenCalled();
      const body = JSON.parse(res.body) as { error?: string; maxAgeMs?: number };
      expect(body.error).toBe("fresh_reauth_required");
      expect(typeof body.maxAgeMs).toBe("number");
    } finally {
      await app.close();
    }
  });

  test("succeeds with valid PIN even when access token is stale", async () => {
    hookAccessTokenIssuedAt = Math.floor(Date.now() / 1000) - 600;
    const verifyProof = mock(async (_userId: string, pin: string) => pin === "918273");
    const pinProvider = { verifyProof } as unknown as PinChallengeProvider;
    const app = makeApp({ pinProvider });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/account/recovery-codes/regenerate",
        headers: { "content-type": "application/json" },
        payload: { pin: "918273" },
      });
      expect(res.statusCode).toBe(200);
      expect(verifyProof).toHaveBeenCalledWith(USER_ID, "918273");
      expect(regenerateLogtoAccountRecoveryCodes).toHaveBeenCalledWith(USER_ID);
    } finally {
      await app.close();
    }
  });

  test("401 when PIN is invalid", async () => {
    hookAccessTokenIssuedAt = Math.floor(Date.now() / 1000) - 60;
    const verifyProof = mock(async () => false);
    const pinProvider = { verifyProof } as unknown as PinChallengeProvider;
    const app = makeApp({ pinProvider });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/account/recovery-codes/regenerate",
        headers: { "content-type": "application/json" },
        payload: { pin: "wrong" },
      });
      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.body)).toEqual({
        error: "Identity re-verification failed.",
      });
      expect(regenerateLogtoAccountRecoveryCodes).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
