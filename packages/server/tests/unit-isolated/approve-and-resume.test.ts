import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

const unexpectedDatabaseAccess = mock(() => {
  throw new Error("Auth validation unit tests must not access a database");
});
mock.module("../../src/lib/server-direct-db", () => ({
  getServerDirectDb: unexpectedDatabaseAccess,
}));
const realAgent = await import("@nautilo/agent");
const resumeSpy = mock(async () => {});
mock.module("@nautilo/agent", () => ({
  ...realAgent,
  resumeGraphWithAskReply: resumeSpy,
  resumeGraphWithApproval: resumeSpy,
  readTurnIdForThread: mock(async () => "validation-turn"),
  readAgentIdForThread: mock(async () => null),
}));
import { fallbackResumePolicy } from "../helpers/auth-resume-policy-fixture";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { PinChallengeProvider } from "@nautilo/trust";
import { authRoutes } from "../../src/routes/auth";
import { SessionStore } from "../helpers/test-session-store";
import { installLocalAuthPreHandlerStub } from "../unit/helpers/auth-preHandler-stub";
import { installResumeInvocationAuthority } from "../helpers/resume-invocation-authority";

let app: FastifyInstance;
let sessionStore: SessionStore;
let validToken: string;

const OWNER_ACTOR_ID = "test-actor-id";
const OWNER_ID = "test-owner-id";

beforeAll(async () => {
  await installResumeInvocationAuthority(OWNER_ID);
  sessionStore = new SessionStore(undefined, { persistPath: null });

  app = Fastify({ logger: false });
  // M052 — auth decoration moved to the global preHandler.
  installLocalAuthPreHandlerStub(app, sessionStore);
  authRoutes(app, {
    ...fallbackResumePolicy,
    pinProvider: new PinChallengeProvider({ persistPath: null }),
    ownerActorId: OWNER_ACTOR_ID,
    ownerId: OWNER_ID,
    assertCanInvokeAgent: async () => undefined,
    resumeThreadMembershipForUser: async () => true,
    projectionResumeBindingForThread: async () => ({ kind: "none" }),
    resumeCausalHumanUserIdForThread: async () => OWNER_ID,
  });

  await app.ready();

  const session = sessionStore.createSession(OWNER_ACTOR_ID, OWNER_ID, OWNER_ID);
  validToken = session.token;
});

afterAll(async () => {
  if (app) await app.close();
  expect(unexpectedDatabaseAccess).not.toHaveBeenCalled();
  expect(resumeSpy).toHaveBeenCalledTimes(2);
  mock.restore();
});

describe("POST /api/auth/prove-and-resume (validation)", () => {
  test("returns 401 without Bearer token", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/prove-and-resume",
      headers: { "Content-Type": "application/json" },
      payload: { pin: "123456", threadId: "thread-1" },
    });
    expect(res.statusCode).toBe(401);
    const body: { error: string } = res.json();
    expect(body.error).toBe("Authentication required");
  });

  test("returns 401 with invalid Bearer token", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/prove-and-resume",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer bogus-token",
      },
      payload: { pin: "123456", threadId: "thread-1" },
    });
    expect(res.statusCode).toBe(401);
  });

  test("returns 400 when threadId is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/prove-and-resume",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${validToken}`,
      },
      payload: { pin: "123456" },
    });
    expect(res.statusCode).toBe(400);
    const body: { error: string } = res.json();
    expect(body.error).toContain("threadId");
  });

  test("returns 400 with PIN too short", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/prove-and-resume",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${validToken}`,
      },
      payload: { pin: "12", threadId: "thread-1" },
    });
    expect(res.statusCode).toBe(400);
  });

  test("returns ok:true for denial (no PIN needed, no DB)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/prove-and-resume",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${validToken}`,
      },
      payload: { denied: true, threadId: "thread-2" },
    });
    expect(res.statusCode).toBe(200);
    const body: { ok: boolean } = res.json();
    expect(body.ok).toBe(true);
  });

  test("accepts optional laneKey on denial", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/prove-and-resume",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${validToken}`,
      },
      payload: { denied: true, threadId: "thread-1", laneKey: "app:custom" },
    });
    expect(res.statusCode).toBe(200);
    const body: { ok: boolean } = res.json();
    expect(body.ok).toBe(true);
  });
});
