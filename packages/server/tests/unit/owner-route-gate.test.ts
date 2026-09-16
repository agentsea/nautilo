/**
 * M128 — TP4 owner-route gate tests (D5).
 *
 * Source spec: ISSUE-M128 §12.1 / §15.1.
 *
 * Verifies `PUT /api/owner` and `PUT /api/owner/handle` gate as per
 * the M128 D5 reframing:
 *
 *   - The bootstrap-owner singleton is the only `sessionUserId` that
 *     can write to its own user row.
 *   - Pre-PIN-enrolled state: loopback IP is admitted (onboarding
 *     wizard runs over loopback before PIN exists).
 *   - Post-PIN-enrolled state: bearer-resolved `sessionUserId ===
 *     ownerId` is the only path through. Any other authenticated user
 *     (admin / household / random) is rejected with 401.
 *
 * Pre-M128 D5 the gate also accepted `actorRole === "owner"` — a
 * pre-multi-user artifact. That branch was dropped; this test pins the
 * new shape so it can't silently regress.
 *
 * Test isolation: we observe gate outcomes by request body shape, not
 * by hitting the DB. A request with `{ name: "" }` passes the gate but
 * fails body validation with 400 — letting us distinguish "gate
 * rejected → 401" from "gate accepted → 400 (later validation)".
 * This avoids needing a real `@nautilo/db` connection for a pure
 * gate test.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { PinChallengeProvider } from "@nautilo/trust";

import { ownerRoutes } from "../../src/routes/owner";
import { SessionStore } from "../helpers/test-session-store";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const OWNER_USER_ID = "owner-user";
const OWNER_ACTOR_ID = "owner-actor";
const HOUSEHOLD_USER_ID = "household-user";
const HOUSEHOLD_ACTOR_ID = "household-actor";

function jsonError(res: { body: string }): string | undefined {
  return (JSON.parse(res.body) as { error?: string }).error;
}

class FakePinProvider {
  private enrolled = false;
  setEnrolled(v: boolean): void {
    this.enrolled = v;
  }
  isEnrolled(_userId: string): Promise<boolean> {
    return Promise.resolve(this.enrolled);
  }
  // Unused methods — interface stubs.
  enroll(): Promise<void> {
    return Promise.resolve();
  }
  verify(): Promise<boolean> {
    return Promise.resolve(false);
  }
  changePin(): Promise<void> {
    return Promise.resolve();
  }
  isLockedOut(): Promise<boolean> {
    return Promise.resolve(false);
  }
  lockoutInfo(): Promise<{ lockedUntilMs: number | null; recentFailures: number }> {
    return Promise.resolve({ lockedUntilMs: null, recentFailures: 0 });
  }
}

function installBearerSessionPreHandler(
  app: FastifyInstance,
  store: SessionStore,
): void {
  app.decorateRequest("sessionUserId", null);
  app.decorateRequest("sessionActorId", null);
  app.decorateRequest("policyContext", null);
  app.addHook("preHandler", async (request) => {
    const auth = request.headers.authorization;
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
    const session = token ? store.validateSession(token) : null;
    if (!session) return;
    request.sessionUserId = session.userId;
    request.sessionActorId = session.actorId;
    // M128 D5: `policyContext.actorRole` is NOT consulted by canMutateOwner
    // post-D5 — the gate is purely `sessionUserId === ownerId`. We still
    // populate the field for parity with the rest of the stack.
    request.policyContext = {
      actorRole: session.userId === session.ownerId ? "owner" : "guest",
      actorLabel: "stub",
    } as unknown as typeof request.policyContext;
  });
}

let app: FastifyInstance;
let sessionStore: SessionStore;
let pinProvider: FakePinProvider;
let ownerToken: string;
let householdToken: string;

beforeAll(async () => {
  sessionStore = new SessionStore(undefined, { persistPath: null });
  pinProvider = new FakePinProvider();

  app = Fastify({ logger: false });
  installBearerSessionPreHandler(app, sessionStore);
  ownerRoutes(app, {
    ownerId: OWNER_USER_ID,
    pinProvider: pinProvider as unknown as PinChallengeProvider,
  });
  await app.ready();

  ownerToken = sessionStore.createSession(
    OWNER_ACTOR_ID,
    OWNER_USER_ID,
    OWNER_USER_ID,
  ).token;
  householdToken = sessionStore.createSession(
    HOUSEHOLD_ACTOR_ID,
    OWNER_USER_ID, // owner of server still = OWNER_USER_ID
    HOUSEHOLD_USER_ID, // but session's authenticated user is the household
  ).token;
});

afterAll(async () => {
  if (app) await app.close();
});

beforeEach(() => {
  pinProvider.setEnrolled(false);
});

// ---------------------------------------------------------------------------
// Gate tests — PUT /api/owner
// ---------------------------------------------------------------------------

describe("PUT /api/owner — M128 D5 gate", () => {
  test("pre-PIN-enrolled + loopback IP + no bearer → gate admits (gate-pass surfaces as 400 body-validation, not 401)", async () => {
    pinProvider.setEnrolled(false);
    const res = await app.inject({
      method: "PUT",
      url: "/api/owner",
      payload: { name: "" }, // gate-pass surfaces as 400 body-validation
      remoteAddress: "127.0.0.1",
    });
    expect(res.statusCode).toBe(400);
    expect(jsonError(res)).toBe("name is required");
  });

  test("pre-PIN-enrolled + non-loopback IP + no bearer → gate REJECTS (401)", async () => {
    pinProvider.setEnrolled(false);
    const res = await app.inject({
      method: "PUT",
      url: "/api/owner",
      payload: { name: "Anyone" },
      remoteAddress: "203.0.113.42",
    });
    expect(res.statusCode).toBe(401);
    expect(jsonError(res)).toBe("owner required");
  });

  test("post-PIN-enrolled + bearer for bootstrap-owner-singleton → gate admits", async () => {
    pinProvider.setEnrolled(true);
    const res = await app.inject({
      method: "PUT",
      url: "/api/owner",
      payload: { name: "" }, // gate-pass surfaces as 400
      headers: { Authorization: `Bearer ${ownerToken}` },
      remoteAddress: "127.0.0.1",
    });
    expect(res.statusCode).toBe(400);
    expect(jsonError(res)).toBe("name is required");
  });

  test("post-PIN-enrolled + bearer for OTHER authenticated user → gate REJECTS (401)", async () => {
    // The regression this test pins: pre-D5 the gate ALSO accepted
    // `actorRole === "owner"`. A non-bootstrap user with that role would
    // have been admitted. Post-D5 the gate is purely `sessionUserId ===
    // ownerId`; the household session here has a different userId and is
    // 401'd even though its policyContext.actorRole could have been any
    // string.
    pinProvider.setEnrolled(true);
    const res = await app.inject({
      method: "PUT",
      url: "/api/owner",
      payload: { name: "Hijack" },
      headers: { Authorization: `Bearer ${householdToken}` },
      remoteAddress: "127.0.0.1",
    });
    expect(res.statusCode).toBe(401);
    expect(jsonError(res)).toBe("owner required");
  });

  test("post-PIN-enrolled + no bearer + loopback → gate REJECTS (401) (loopback only matters pre-PIN)", async () => {
    pinProvider.setEnrolled(true);
    const res = await app.inject({
      method: "PUT",
      url: "/api/owner",
      payload: { name: "Anyone" },
      remoteAddress: "127.0.0.1",
    });
    expect(res.statusCode).toBe(401);
    expect(jsonError(res)).toBe("owner required");
  });
});

// ---------------------------------------------------------------------------
// Gate tests — PUT /api/owner/handle (same gate; same matrix)
// ---------------------------------------------------------------------------

describe("PUT /api/owner/handle — M128 D5 gate", () => {
  test("pre-PIN + loopback + no bearer → gate admits (200 / handle write)", async () => {
    pinProvider.setEnrolled(false);
    const res = await app.inject({
      method: "PUT",
      url: "/api/owner/handle",
      payload: { handle: "invalid handle with space" }, // gate-pass surfaces as 400 handle validation
      remoteAddress: "127.0.0.1",
    });
    // gate passed → body validation reached → handle is invalid → 400
    expect(res.statusCode).toBe(400);
  });

  test("post-PIN + non-bootstrap bearer → gate REJECTS (401)", async () => {
    pinProvider.setEnrolled(true);
    const res = await app.inject({
      method: "PUT",
      url: "/api/owner/handle",
      payload: { handle: "anyone" },
      headers: { Authorization: `Bearer ${householdToken}` },
      remoteAddress: "127.0.0.1",
    });
    expect(res.statusCode).toBe(401);
    expect(jsonError(res)).toBe("owner required");
  });
});
