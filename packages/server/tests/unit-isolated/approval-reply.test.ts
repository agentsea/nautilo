import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

const unexpectedDatabaseAccess = mock(() => {
  throw new Error("Auth validation unit tests must not access a database");
});
mock.module("../../src/lib/server-direct-db", () => ({
  getServerDirectDb: unexpectedDatabaseAccess,
}));
const realAgent = await import("@nautilo/agent");
const resumeSpy = mock(async () => {});
let checkpointCausalHumanUserId: string | null = "checkpoint-causal-human";
mock.module("@nautilo/agent", () => ({
  ...realAgent,
  resumeGraphWithAskReply: resumeSpy,
  resumeGraphWithApproval: resumeSpy,
  readTurnIdForThread: mock(async () => "validation-turn"),
  readCausalHumanUserIdForThread: mock(async () => checkpointCausalHumanUserId),
  readAgentIdForThread: mock(async () => null),
}));
import { fallbackResumePolicy } from "../helpers/auth-resume-policy-fixture";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { AgentInvocationDeniedError, PinChallengeProvider } from "@nautilo/trust";
import { authRoutes } from "../../src/routes/auth";
import { SessionStore } from "../helpers/test-session-store";
import { installLocalAuthPreHandlerStub } from "../unit/helpers/auth-preHandler-stub";

let app: FastifyInstance;
let sessionStore: SessionStore;
let validToken: string;

const OWNER_ACTOR_ID = "test-actor-id";
const OWNER_ID = "test-owner-id";

beforeAll(async () => {
  sessionStore = new SessionStore(undefined, { persistPath: null });

  app = Fastify({ logger: false });
  // M052 — auth state is now decorated by the global preHandler in
  // production (see `packages/server/src/app.ts`). This stub mirrors
  // that contract for the unit-test surface.
  installLocalAuthPreHandlerStub(app, sessionStore);
  authRoutes(app, {
    ...fallbackResumePolicy,
    pinProvider: new PinChallengeProvider({ persistPath: null }),
    ownerActorId: OWNER_ACTOR_ID,
    ownerId: OWNER_ID,
    assertCanInvokeAgent: async () => undefined,
    resumeThreadMembershipForUser: async () => true,
    projectionResumeBindingForThread: async () => ({ kind: "none" }),
  });

  await app.ready();

  const session = sessionStore.createSession(OWNER_ACTOR_ID, OWNER_ID, OWNER_ID);
  validToken = session.token;
});

afterAll(async () => {
  if (app) await app.close();
  expect(unexpectedDatabaseAccess).not.toHaveBeenCalled();
  expect(resumeSpy).toHaveBeenCalledTimes(5);
  mock.restore();
});

/**
 * Route validation tests use an in-memory policy and graph-resume spy.
 * The HTTP route still performs its real background dispatch, and teardown
 * verifies that accepted replies reached the spy without a database lookup.
 */

describe("POST /api/auth/approval-reply (validation)", () => {
  test("returns 401 without Bearer token", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/approval-reply",
      headers: { "Content-Type": "application/json" },
      payload: { verb: "once", threadId: "thread-1" },
    });
    expect(res.statusCode).toBe(401);
    const body: { error: string } = res.json();
    expect(body.error).toBe("Authentication required");
  });

  test("returns 401 with invalid Bearer token", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/approval-reply",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer bogus-token",
      },
      payload: { verb: "once", threadId: "thread-1" },
    });
    expect(res.statusCode).toBe(401);
  });

  test("returns 400 when threadId is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/approval-reply",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${validToken}`,
      },
      payload: { verb: "once" },
    });
    expect(res.statusCode).toBe(400);
    const body: { error: string } = res.json();
    expect(body.error).toContain("threadId");
  });

  test("returns 400 when verb is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/approval-reply",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${validToken}`,
      },
      payload: { threadId: "thread-1" },
    });
    expect(res.statusCode).toBe(400);
    const body: { error: string } = res.json();
    expect(body.error).toContain("verb");
  });

  test("returns 400 when verb is not one of the four allowed values", async () => {
    for (const bogus of ["approve", "reject", "maybe", "", "ONCE"]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/approval-reply",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${validToken}`,
        },
        payload: { verb: bogus, threadId: "thread-1" },
      });
      expect(res.statusCode).toBe(400);
    }
  });

  test("accepts each of the four valid verbs", async () => {
    // Graph resume is stubbed; accepted replies must still reach that stub.
    for (const verb of ["once", "room", "always", "deny"] as const) {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/approval-reply",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${validToken}`,
        },
        payload: { verb, threadId: "thread-never-real" },
      });
      expect(res.statusCode).toBe(200);
      const body: { ok?: boolean } = res.json();
      expect(body.ok).toBe(true);
    }
  });

  test("accepts optional laneKey body field", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/approval-reply",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${validToken}`,
      },
      payload: { verb: "once", threadId: "thread-never-real", laneKey: "lane-xyz" },
    });
    expect(res.statusCode).toBe(200);
  });

});

describe("M254 foreground resume admission", () => {
  test("checks the checkpoint initiating Human rather than another Room responder", async () => {
    const localSessions = new SessionStore(undefined, { persistPath: null });
    const localApp = Fastify({ logger: false });
    installLocalAuthPreHandlerStub(localApp, localSessions);
    authRoutes(localApp, {
      pinProvider: new PinChallengeProvider({ persistPath: null }),
      ownerActorId: OWNER_ACTOR_ID,
      ownerId: OWNER_ID,
      resumeThreadMembershipForUser: async () => true,
      projectionResumeBindingForThread: async () => ({ kind: "none" }),
      assertCanInvokeAgent: async (input) => {
        expect(input.humanUserId).toBe("checkpoint-causal-human");
        throw new AgentInvocationDeniedError(input);
      },
    });
    const token = localSessions.createSession(OWNER_ACTOR_ID, OWNER_ID, OWNER_ID).token;
    const response = await localApp.inject({
      method: "POST",
      url: "/api/auth/approval-reply",
      headers: { Authorization: `Bearer ${token}` },
      payload: { verb: "once", threadId: "thread-bound" },
    });
    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body)).toEqual({
      error: "invoke_agents_required",
      code: "invoke_agents_required",
      capability: "invoke_agents",
    });
    await localApp.close();
  });

  test("fails closed when the checkpoint has no initiating Human", async () => {
    checkpointCausalHumanUserId = null;
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/approval-reply",
        headers: { Authorization: `Bearer ${validToken}` },
        payload: { verb: "once", threadId: "thread-missing-causal-human" },
      });
      expect(response.statusCode).toBe(403);
      expect(JSON.parse(response.body)).toEqual({
        error: "invoke_agents_required",
        code: "invoke_agents_required",
        capability: "invoke_agents",
      });
    } finally {
      checkpointCausalHumanUserId = "checkpoint-causal-human";
    }
  });
});
