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
import type { ProjectionResumeBinding } from "@nautilo/agent";
import { authRoutes, projectionResumeAllowed } from "../../src/routes/auth";
import { SessionStore } from "../helpers/test-session-store";
import { installLocalAuthPreHandlerStub } from "../unit/helpers/auth-preHandler-stub";
import { installResumeInvocationAuthority } from "../helpers/resume-invocation-authority";

const INITIATOR = {
  actorId: "initiator-actor",
  userId: "initiator-user",
};
const OTHER_MEMBER = {
  actorId: "other-member-actor",
  userId: "other-member-user",
};
const SAME_USER_OTHER_ACTOR = {
  actorId: "other-actor",
  userId: INITIATOR.userId,
};

const bound: ProjectionResumeBinding = {
  kind: "bound",
  requesterUserId: INITIATOR.userId,
  requesterActorId: INITIATOR.actorId,
};

let app: FastifyInstance;
let sessions: SessionStore;
let initiatorToken: string;
let otherMemberToken: string;
let sameUserOtherActorToken: string;
const auditEvents: unknown[] = [];
let binding: ProjectionResumeBinding = bound;

beforeAll(async () => {
  await installResumeInvocationAuthority(INITIATOR.userId);
  sessions = new SessionStore(undefined, { persistPath: null });
  app = Fastify({ logger: false });
  installLocalAuthPreHandlerStub(app, sessions);
  authRoutes(app, {
    ...fallbackResumePolicy,
    pinProvider: new PinChallengeProvider({ persistPath: null }),
    ownerActorId: INITIATOR.actorId,
    ownerId: INITIATOR.userId,
    assertCanInvokeAgent: async () => undefined,
    resumeThreadMembershipForUser: async () => true,
    projectionResumeBindingForThread: async () => binding,
    resumeCausalHumanUserIdForThread: async () => INITIATOR.userId,
    auditEvent: async (event) => { auditEvents.push(event); },
  });
  await app.ready();
  initiatorToken = sessions.createSession(INITIATOR.actorId, INITIATOR.userId, INITIATOR.userId).token;
  otherMemberToken = sessions.createSession(OTHER_MEMBER.actorId, INITIATOR.userId, OTHER_MEMBER.userId).token;
  sameUserOtherActorToken = sessions.createSession(
    SAME_USER_OTHER_ACTOR.actorId,
    INITIATOR.userId,
    SAME_USER_OTHER_ACTOR.userId,
  ).token;
});

afterAll(async () => {
  await app.close();
  expect(unexpectedDatabaseAccess).not.toHaveBeenCalled();
  expect(resumeSpy).toHaveBeenCalledTimes(1);
  mock.restore();
});

function auth(token: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

describe("D476 projection approval resume binding", () => {
  test("allows only the initiating user and actor", async () => {
    expect(await projectionResumeAllowed(
      async () => bound,
      "thread",
      INITIATOR.userId,
      INITIATOR.actorId,
    )).toBe(true);
    expect(await projectionResumeAllowed(
      async () => bound,
      "thread",
      OTHER_MEMBER.userId,
      OTHER_MEMBER.actorId,
    )).toBe(false);
    expect(await projectionResumeAllowed(
      async () => bound,
      "thread",
      INITIATOR.userId,
      SAME_USER_OTHER_ACTOR.actorId,
    )).toBe(false);
    expect(await projectionResumeAllowed(
      async () => bound,
      "thread",
      INITIATOR.userId,
      null,
    )).toBe(false);
    expect(await projectionResumeAllowed(
      async () => { throw new Error("checkpoint unavailable"); },
      "thread",
      INITIATOR.userId,
      INITIATOR.actorId,
    )).toBe(false);
  });

  test("does not alter a legacy resume with no pending projection", async () => {
    binding = { kind: "none" };
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/prove-and-resume",
      headers: auth(initiatorToken),
      payload: { denied: true, threadId: "legacy-thread" },
    });
    expect(response.statusCode).toBe(200);
  });

  test("blocks another Room member before prove_it resumes and audits without projection data", async () => {
    binding = bound;
    auditEvents.length = 0;
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/prove-and-resume",
      headers: auth(otherMemberToken),
      payload: { denied: true, threadId: "projection-thread" },
    });
    expect(response.statusCode).toBe(403);
    const body: { error: string } = response.json();
    expect(body).toEqual({ error: "Forbidden" });
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({ kind: "resume_thread_auth_denied" });
    expect(JSON.stringify(auditEvents[0])).not.toContain("proposed_content");
    expect(JSON.stringify(auditEvents[0])).not.toContain("source_memory");
  });

  test("blocks another Room member before approval_ask resumes", async () => {
    binding = bound;
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/approval-reply",
      headers: auth(otherMemberToken),
      payload: { verb: "deny", threadId: "projection-thread" },
    });
    expect(response.statusCode).toBe(403);
    const body: { error: string } = response.json();
    expect(body).toEqual({ error: "Forbidden" });
  });

  test("fails closed on malformed active projection state", async () => {
    binding = { kind: "malformed" };
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/approval-reply",
      headers: auth(initiatorToken),
      payload: { verb: "deny", threadId: "projection-thread" },
    });
    expect(response.statusCode).toBe(403);
  });

  test("blocks a different actor for the same authenticated user", async () => {
    binding = bound;
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/prove-and-resume",
      headers: auth(sameUserOtherActorToken),
      payload: { denied: true, threadId: "projection-thread" },
    });
    expect(response.statusCode).toBe(403);
  });
});
