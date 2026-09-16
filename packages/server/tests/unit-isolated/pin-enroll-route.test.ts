/**
 * M054 — `POST /api/auth/pin` enrollment-when-absent contract.
 *
 * Pre-M054 the route required both `currentPin` + `newPin`. Under
 * Under Logto-only (M072), a brand-new Logto-authed user has no PIN; the
 * workbench's enrollPin flow POSTs `{ newPin }` only. The route
 * branches on `pinProvider.isEnrolled(userId)`:
 *   - not enrolled → enroll via `enroll(userId, newPin)`. 200.
 *   - enrolled     → require `currentPin` and call `changePin`. 200.
 *
 * Tests stub the PIN provider so we don't depend on a Postgres
 * connection. The graph-resume side-effect (when `threadId` is
 * present) is also stubbed out via env: omitting `threadId` from
 * the body gives the route a no-op early return on the resume path,
 * which is what we want here. Graph resume is exercised separately
 * in the full integration suite.
 *
 * M063 — `generateRecoveryCodes` hits Postgres; mock it so enrollment
 * stays hermetic (same pattern as `resolve-bearer.test.ts`).
 */
import { describe, test, expect, beforeAll, afterAll, mock } from "bun:test";

mock.module("@nautilo/trust", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const trust = require("@nautilo/trust") as Record<string, unknown>;
  return {
    ...trust,
    generateRecoveryCodes: async () =>
      Array.from({ length: 8 }, (_, i) => `${i}`.repeat(8).padEnd(24, "0")),
  };
});

import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import {
  PinAlreadyEnrolledError,
  type ChallengeProvider,
} from "@nautilo/trust";
import { authRoutes } from "../../src/routes/auth";
import { SessionStore } from "../helpers/test-session-store";
import { installLocalAuthPreHandlerStub } from "../unit/helpers/auth-preHandler-stub";
import type { SecurityAuditEvent } from "../../src/lib/security-audit-log";

const OWNER_ACTOR_ID = "owner-actor-id";
const OWNER_ID = "owner-user-id";

interface FakePinProvider extends ChallengeProvider {
  enroll: (userId: string, pin: string) => Promise<void>;
  changePin: (
    userId: string,
    currentPin: string,
    newPin: string,
  ) => Promise<void>;
  setPinAfterFreshJwt: (userId: string, newPin: string) => Promise<void>;
  state: {
    enrolled: Map<string, string>;
    enrollCalls: Array<{ userId: string; pin: string }>;
    changeCalls: Array<{ userId: string; currentPin: string; newPin: string }>;
    setPinAfterFreshJwtCalls: Array<{ userId: string; newPin: string }>;
  };
}

function makeFakePinProvider(initiallyEnrolled = false): FakePinProvider {
  const state = {
    enrolled: new Map<string, string>(),
    enrollCalls: [] as Array<{ userId: string; pin: string }>,
    changeCalls: [] as Array<{
      userId: string;
      currentPin: string;
      newPin: string;
    }>,
    setPinAfterFreshJwtCalls: [] as Array<{ userId: string; newPin: string }>,
  };
  if (initiallyEnrolled) {
    state.enrolled.set(OWNER_ID, "111111");
  }
  return {
    state,
    async isEnrolled(userId: string) {
      return state.enrolled.has(userId);
    },
    async verifyProof(userId: string, proof: string) {
      return state.enrolled.get(userId) === proof;
    },
    async enroll(userId: string, pin: string) {
      if (state.enrolled.has(userId)) {
        throw new PinAlreadyEnrolledError();
      }
      state.enrollCalls.push({ userId, pin });
      state.enrolled.set(userId, pin);
    },
    async changePin(userId: string, currentPin: string, newPin: string) {
      state.changeCalls.push({ userId, currentPin, newPin });
      if (state.enrolled.get(userId) !== currentPin) {
        const { InvalidPinError } = await import("@nautilo/trust");
        throw new InvalidPinError();
      }
      state.enrolled.set(userId, newPin);
    },
    async setPinAfterFreshJwt(userId: string, newPin: string) {
      state.setPinAfterFreshJwtCalls.push({ userId, newPin });
      state.enrolled.set(userId, newPin);
    },
  };
}

interface Harness {
  app: FastifyInstance;
  fake: FakePinProvider;
  sessionStore: SessionStore;
  token: string;
  auditEvents: SecurityAuditEvent[];
}

async function makeHarness(
  initiallyEnrolled: boolean,
  stubOptions?: { accessTokenIssuedAtSeconds?: number | null },
): Promise<Harness> {
  const sessionStore = new SessionStore(undefined, { persistPath: null });
  const app = Fastify({ logger: false });
  installLocalAuthPreHandlerStub(app, sessionStore, stubOptions);
  const fake = makeFakePinProvider(initiallyEnrolled);
  const auditEvents: SecurityAuditEvent[] = [];
  authRoutes(app, {
    // Only `enroll`, `changePin`, `isEnrolled` are exercised on this
    // route — cast through unknown so the in-memory fake can stand
    // in for `PinChallengeProvider` without the rest of the API.
    pinProvider: fake as unknown as Parameters<typeof authRoutes>[1]["pinProvider"],
    ownerActorId: OWNER_ACTOR_ID,
    ownerId: OWNER_ID,
    auditEvent: async (event) => {
      auditEvents.push(event);
    },
  });
  await app.ready();
  const session = sessionStore.createSession(OWNER_ACTOR_ID, OWNER_ID, OWNER_ID);
  return { app, fake, sessionStore, token: session.token, auditEvents };
}

describe("POST /api/auth/pin (M054 enrollment-when-absent)", () => {
  let h: Harness;

  beforeAll(async () => {
    h = await makeHarness(false);
  });
  afterAll(async () => {
    if (h?.app) await h.app.close();
  });

  test("not-enrolled user can enroll with just `newPin` — calls enroll(userId, newPin)", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/auth/pin",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${h.token}`,
      },
      payload: { newPin: "234567" },
    });
    expect(res.statusCode).toBe(200);
    const body: {
      ok: boolean;
      enrolled?: boolean;
      recoveryCodes?: string[];
    } = res.json();
    expect(body.ok).toBe(true);
    expect(body.enrolled).toBe(true);
    expect(body.recoveryCodes).toHaveLength(8);
    expect(
      body.recoveryCodes!.every(
        (c) => typeof c === "string" && c.length >= 8,
      ),
    ).toBe(true);
    expect(h.fake.state.enrollCalls).toHaveLength(1);
    expect(h.fake.state.enrollCalls[0]!.userId).toBe(OWNER_ID);
    expect(h.fake.state.enrollCalls[0]!.pin).toBe("234567");
  });

  test("first-time enroll writes pin_enrolled security audit event", async () => {
    const fresh = await makeHarness(false);
    fresh.auditEvents.length = 0;
    const res = await fresh.app.inject({
      method: "POST",
      url: "/api/auth/pin",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${fresh.token}`,
      },
      payload: { newPin: "345678" },
    });
    expect(res.statusCode).toBe(200);
    expect(fresh.auditEvents).toHaveLength(1);
    expect(fresh.auditEvents[0]).toMatchObject({
      kind: "pin_enrolled",
      sessionUserId: OWNER_ID,
      route: "POST /api/auth/pin",
    });
    await fresh.app.close();
  });

  test("rejects weak PIN even on enroll path", async () => {
    const fresh = await makeHarness(false);
    const res = await fresh.app.inject({
      method: "POST",
      url: "/api/auth/pin",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${fresh.token}`,
      },
      payload: { newPin: "123456" },
    });
    expect(res.statusCode).toBe(400);
    expect(fresh.fake.state.enrollCalls).toHaveLength(0);
    await fresh.app.close();
  });

  test("rejects too-short PIN even on enroll path", async () => {
    const fresh = await makeHarness(false);
    const res = await fresh.app.inject({
      method: "POST",
      url: "/api/auth/pin",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${fresh.token}`,
      },
      payload: { newPin: "12" },
    });
    expect(res.statusCode).toBe(400);
    await fresh.app.close();
  });

  test("returns 400 if newPin missing", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/auth/pin",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${h.token}`,
      },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  test("401 without Bearer", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/auth/pin",
      headers: { "Content-Type": "application/json" },
      payload: { newPin: "234567" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("POST /api/auth/pin (already enrolled — change-PIN path preserved)", () => {
  let h: Harness;

  beforeAll(async () => {
    h = await makeHarness(true);
  });
  afterAll(async () => {
    if (h?.app) await h.app.close();
  });

  test("missing currentPin when already enrolled — 401 fresh_reauth_required without fresh JWT", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/auth/pin",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${h.token}`,
      },
      payload: { newPin: "789012" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "fresh_reauth_required" });
    expect(h.fake.state.changeCalls).toHaveLength(0);
    expect(h.fake.state.setPinAfterFreshJwtCalls).toHaveLength(0);
  });

  test("missing currentPin + fresh JWT iat — 200 via setPinAfterFreshJwt", async () => {
    const fresh = await makeHarness(true, {
      accessTokenIssuedAtSeconds: Math.floor(Date.now() / 1000),
    });
    const res = await fresh.app.inject({
      method: "POST",
      url: "/api/auth/pin",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${fresh.token}`,
      },
      payload: { newPin: "789012" },
    });
    expect(res.statusCode).toBe(200);
    expect(fresh.fake.state.changeCalls).toHaveLength(0);
    expect(fresh.fake.state.setPinAfterFreshJwtCalls).toHaveLength(1);
    expect(fresh.fake.state.setPinAfterFreshJwtCalls[0]!.newPin).toBe("789012");
    await fresh.app.close();
  });

  test("happy change-PIN: provides currentPin + newPin → 200, calls changePin", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/auth/pin",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${h.token}`,
      },
      payload: { currentPin: "111111", newPin: "789012" },
    });
    expect(res.statusCode).toBe(200);
    const body: {
      ok: boolean;
      enrolled?: boolean;
      recoveryCodes?: string[];
    } = res.json();
    expect(body.ok).toBe(true);
    expect(body.enrolled).toBeUndefined();
    expect(body.recoveryCodes).toBeUndefined();
    expect(h.fake.state.changeCalls).toHaveLength(1);
    expect(h.fake.state.changeCalls[0]!.currentPin).toBe("111111");
    expect(h.fake.state.changeCalls[0]!.newPin).toBe("789012");
  });

  test("wrong currentPin → 401", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/auth/pin",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${h.token}`,
      },
      payload: { currentPin: "999999", newPin: "234567" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /api/auth/pin-enrollment", () => {
  test("401 without Bearer", async () => {
    const sessionStore = new SessionStore(undefined, { persistPath: null });
    const app = Fastify({ logger: false });
    installLocalAuthPreHandlerStub(app, sessionStore);
    const fake = makeFakePinProvider(false);
    authRoutes(app, {
      pinProvider: fake as unknown as Parameters<typeof authRoutes>[1]["pinProvider"],
      ownerActorId: OWNER_ACTOR_ID,
      ownerId: OWNER_ID,
    });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/api/auth/pin-enrollment" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  test("returns enrolled:false when user has no PIN", async () => {
    const h = await makeHarness(false);
    const res = await h.app.inject({
      method: "GET",
      url: "/api/auth/pin-enrollment",
      headers: { Authorization: `Bearer ${h.token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ enrolled: boolean }>()).toEqual({ enrolled: false });
    await h.app.close();
  });

  test("returns enrolled:true when user already has PIN", async () => {
    const h = await makeHarness(true);
    const res = await h.app.inject({
      method: "GET",
      url: "/api/auth/pin-enrollment",
      headers: { Authorization: `Bearer ${h.token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ enrolled: boolean }>()).toEqual({ enrolled: true });
    await h.app.close();
  });
});

afterAll(() => {
  mock.restore();
});
