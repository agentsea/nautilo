/**
 * M063 — POST /api/auth/recover (Logto-linked recovery; M072 Logto-only).
 */
import { describe, test, expect, afterEach, afterAll, mock } from "bun:test";
import type { UseRecoveryCodeResult } from "@nautilo/trust";
import Fastify from "fastify";
import { authRoutes } from "../../src/routes/auth";
import { SessionStore } from "../helpers/test-session-store";
import { installLocalAuthPreHandlerStub } from "../unit/helpers/auth-preHandler-stub";

const OWNER_ACTOR_ID = "owner-actor-id";
const OWNER_ID = "owner-user-id";

const useRecoveryCodeMock = mock(
  async (
    _ownerId: string,
    _code: string,
    _newPin: string,
  ): Promise<UseRecoveryCodeResult> => ({
    success: true,
    codesRemaining: 7,
  }),
);

mock.module("@nautilo/trust", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const trust = require("@nautilo/trust") as Record<string, unknown>;
  return {
    ...trust,
    useRecoveryCode: useRecoveryCodeMock,
    generateRecoveryCodes: trust["generateRecoveryCodes"],
  };
});

type RecoverResponseBody = {
  token?: string;
  codesRemaining: number;
  ok?: boolean;
};

function readRecoverBody(payload: unknown): RecoverResponseBody {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("expected JSON object");
  }
  const o = payload as Record<string, unknown>;
  const codesRemaining =
    typeof o["codesRemaining"] === "number" ? o["codesRemaining"] : NaN;
  return {
    ...(typeof o["token"] === "string" ? { token: o["token"] } : {}),
    codesRemaining,
    ...(o["ok"] === true ? { ok: true as const } : {}),
  };
}

describe("POST /api/auth/recover (M063)", () => {
  afterEach(() => {
    useRecoveryCodeMock.mockClear();
  });

  test("returns ok + codesRemaining; no token (Logto path)", async () => {
    const sessionStore = new SessionStore(undefined, { persistPath: null });
    const app = Fastify({ logger: false });
    installLocalAuthPreHandlerStub(app, sessionStore);
    const session = sessionStore.createSession(OWNER_ACTOR_ID, OWNER_ID, OWNER_ID);
    authRoutes(app, {
      pinProvider: {} as never,
      ownerActorId: OWNER_ACTOR_ID,
      ownerId: OWNER_ID,
    });
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/recover",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.token}`,
      },
      payload: {
        recoveryCode: "cafebabe",
        newPin: "876543",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = readRecoverBody(res.json());
    expect(body.ok).toBe(true);
    expect(body.codesRemaining).toBe(7);
    expect(body.token).toBeUndefined();

    await app.close();
  });

  test("401 without Bearer", async () => {
    const sessionStore = new SessionStore(undefined, { persistPath: null });
    const app = Fastify({ logger: false });
    installLocalAuthPreHandlerStub(app, sessionStore);
    authRoutes(app, {
      pinProvider: {} as never,
      ownerActorId: OWNER_ACTOR_ID,
      ownerId: OWNER_ID,
    });
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/recover",
      headers: { "Content-Type": "application/json" },
      payload: { recoveryCode: "abc", newPin: "876543" },
    });
    expect(res.statusCode).toBe(401);

    await app.close();
  });

  test("401 when actorRole is guest (Bearer present)", async () => {
    const sessionStore = new SessionStore(undefined, { persistPath: null });
    const app = Fastify({ logger: false });
    installLocalAuthPreHandlerStub(app, sessionStore);
    app.addHook("preHandler", (request, _reply, done) => {
      if (request.headers["x-test-force-guest-role"] === "1") {
        request.policyContext = {
          actorRole: "guest",
          actorId: "guest",
        } as typeof request.policyContext;
      }
      done();
    });
    const session = sessionStore.createSession(OWNER_ACTOR_ID, OWNER_ID, OWNER_ID);
    authRoutes(app, {
      pinProvider: {} as never,
      ownerActorId: OWNER_ACTOR_ID,
      ownerId: OWNER_ID,
    });
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/recover",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.token}`,
        "x-test-force-guest-role": "1",
      },
      payload: { recoveryCode: "abc", newPin: "876543" },
    });
    expect(res.statusCode).toBe(401);

    await app.close();
  });

  test("200 with recovery code when request IP is not localhost (M102)", async () => {
    const sessionStore = new SessionStore(undefined, { persistPath: null });
    const app = Fastify({ logger: false });
    installLocalAuthPreHandlerStub(app, sessionStore);
    const session = sessionStore.createSession(OWNER_ACTOR_ID, OWNER_ID, OWNER_ID);
    authRoutes(app, {
      pinProvider: {} as never,
      ownerActorId: OWNER_ACTOR_ID,
      ownerId: OWNER_ID,
    });
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/recover",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.token}`,
      },
      payload: { recoveryCode: "abc", newPin: "876543" },
      remoteAddress: "203.0.113.10",
    });
    expect(res.statusCode).toBe(200);
    const body = readRecoverBody(res.json());
    expect(body.ok).toBe(true);
    expect(body.codesRemaining).toBe(7);

    await app.close();
  });

  test("401 when recovery code is invalid (trust layer)", async () => {
    useRecoveryCodeMock.mockImplementationOnce(
      async (): Promise<UseRecoveryCodeResult> => ({
        success: false,
        reason: "invalid",
      }),
    );

    const sessionStore = new SessionStore(undefined, { persistPath: null });
    const app = Fastify({ logger: false });
    installLocalAuthPreHandlerStub(app, sessionStore);
    const session = sessionStore.createSession(OWNER_ACTOR_ID, OWNER_ID, OWNER_ID);
    authRoutes(app, {
      pinProvider: {} as never,
      ownerActorId: OWNER_ACTOR_ID,
      ownerId: OWNER_ID,
    });
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/recover",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.token}`,
      },
      payload: { recoveryCode: "wrongcode", newPin: "876543" },
    });
    expect(res.statusCode).toBe(401);
    const body: { error?: string } = res.json();
    expect(body.error).toBe("Invalid recovery code");

    await app.close();
  });

  test("400 when no unused recovery codes remain", async () => {
    useRecoveryCodeMock.mockImplementationOnce(
      async (): Promise<UseRecoveryCodeResult> => ({
        success: false,
        reason: "no_codes",
      }),
    );

    const sessionStore = new SessionStore(undefined, { persistPath: null });
    const app = Fastify({ logger: false });
    installLocalAuthPreHandlerStub(app, sessionStore);
    const session = sessionStore.createSession(OWNER_ACTOR_ID, OWNER_ID, OWNER_ID);
    authRoutes(app, {
      pinProvider: {} as never,
      ownerActorId: OWNER_ACTOR_ID,
      ownerId: OWNER_ID,
    });
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/recover",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.token}`,
      },
      payload: { recoveryCode: "any", newPin: "876543" },
    });
    expect(res.statusCode).toBe(400);
    const body: { error?: string } = res.json();
    expect(body.error).toContain("No unused recovery codes remain");

    await app.close();
  });
});

afterAll(() => {
  mock.restore();
});
