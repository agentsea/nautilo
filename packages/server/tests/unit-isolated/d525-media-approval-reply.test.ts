import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

const unexpectedDatabaseAccess = mock(() => {
  throw new Error("Media approval unit tests must not access a database");
});
mock.module("../../src/lib/server-direct-db", () => ({
  getServerDirectDb: unexpectedDatabaseAccess,
}));

let ordinaryResumeCalled = Promise.withResolvers<void>();
let taskResumeCalled = Promise.withResolvers<void>();
const resumeSpy = mock(async (..._args: unknown[]) => {
  ordinaryResumeCalled.resolve();
});
const taskResumeSpy = mock(async (_args: unknown) => {
  taskResumeCalled.resolve();
  return { reparked: false };
});

const realAgent = await import("@nautilo/agent");
mock.module("@nautilo/agent", () => ({
  ...realAgent,
  resumeGraphWithAskReply: resumeSpy,
  resumeGraphWithApproval: mock(async () => {}),
  resumeGraphWithIdentity: mock(async () => {}),
  readTurnIdForThread: mock(async () => "d525-turn"),
  readProjectionResumeBindingForThread: mock(async () => ({ kind: "none" as const })),
}));

const realRuntime = await import("@nautilo/runtime");
const pendingResumeLifecycles: Promise<unknown>[] = [];
mock.module("@nautilo/runtime", () => ({
  ...realRuntime,
  authorizeTaskApprovalResume: mock(async (args: {
    taskId: string;
    threadId: string;
    sessionUserId: string;
  }) => ({
    ok: true as const,
    task: {
      id: args.taskId,
      ownerId: args.sessionUserId,
      requestorId: args.sessionUserId,
      agentId: "d525-agent",
      targetChat: "orphan",
      targetRoomId: null,
      scheduleKind: "once",
    },
    run: { id: "d525-run", graphThreadId: args.threadId },
  })),
  runTaskApprovalResume: taskResumeSpy,
}));

import Fastify, { type FastifyInstance } from "fastify";
import { PinChallengeProvider } from "@nautilo/trust";
import type { MediaGenerationApproval } from "@nautilo/types";
import { authRoutes } from "../../src/routes/auth";
import { SessionStore } from "../helpers/test-session-store";
import { installLocalAuthPreHandlerStub } from "../unit/helpers/auth-preHandler-stub";
import { installResumeInvocationAuthority } from "../helpers/resume-invocation-authority";

const OWNER_ID = "d525-owner";
let app: FastifyInstance;
let token: string;

const mediaGeneration: MediaGenerationApproval = {
  version: "media-generation-approval-v1",
  digest: "a".repeat(64),
  quoteDigest: "b".repeat(64),
  revision: 1,
  expiresAt: "2099-01-01T00:00:00.000Z",
  preview: {
    mediaKind: "video",
    model: "seedance-2-5-text-to-video-basic",
    settings: { durationSeconds: 5, aspectRatio: "16:9", resolution: "720p", audio: true },
    prompt: { characterCount: 13, summary: "Ocean at dusk", truncated: false },
    quote: { currency: "USD", amountMicros: 1_250_000, display: "USD 1.250000" },
    spendNotice: "Approving starts a paid generation using this exact quote.",
  },
};

beforeAll(async () => {
  const resumeJobs = await installResumeInvocationAuthority(OWNER_ID);
  const runResumeJobLifecycle = resumeJobs.runResumeJobLifecycle.bind(resumeJobs);
  spyOn(realRuntime.jobManager, "runResumeJobLifecycle").mockImplementation((...args) => {
    const completion = runResumeJobLifecycle(...args);
    pendingResumeLifecycles.push(completion);
    return completion;
  });
  const sessions = new SessionStore(undefined, { persistPath: null });
  app = Fastify({ logger: false });
  installLocalAuthPreHandlerStub(app, sessions);
  authRoutes(app, {
    pinProvider: new PinChallengeProvider({ persistPath: null }),
    ownerActorId: OWNER_ID,
    ownerId: OWNER_ID,
    resumeThreadMembershipForUser: async () => true,
    resumeCausalHumanUserIdForThread: async () => OWNER_ID,
    assertCanInvokeAgent: async () => {},
    // Exercise authenticated approval transport, not durable policy storage.
    strictShadowPolicyReader: async () => ({
      mode: "shadow_encryption",
      shadowBehavior: "fallback",
      revision: 1,
      shadowEncryptionStartedAt: null,
      updatedAt: new Date(0),
    }),
    strictShadowBoundaryEnforcer: async (input) => ({
      policy: {
        mode: "shadow_encryption",
        shadowBehavior: "fallback",
        revision: 1,
        shadowEncryptionStartedAt: null,
        updatedAt: new Date(0),
      },
      result: {
        disposition: "ordinary",
        decision: {
          boundaryId: input.boundaryId,
          family: "checkpoint",
          operation: "write",
          actorClass: "agent",
          state: input.state,
          reason: input.reason,
          retryable: input.retryable,
          policyRevision: 1,
        },
      },
    }),
  });
  await app.ready();
  token = sessions.createSession(OWNER_ID, OWNER_ID, OWNER_ID).token;
});

beforeEach(() => {
  ordinaryResumeCalled = Promise.withResolvers<void>();
  taskResumeCalled = Promise.withResolvers<void>();
  resumeSpy.mockClear();
  taskResumeSpy.mockClear();
});

afterEach(async () => {
  // A called resume mock does not mean its real Job lifecycle has settled.
  // Drain it before the next test resets mocks or observes route side effects.
  const results = await Promise.allSettled(pendingResumeLifecycles.splice(0));
  for (const result of results) expect(result.status).toBe("fulfilled");
});

afterAll(async () => {
  await app.close();
  expect(unexpectedDatabaseAccess).not.toHaveBeenCalled();
  mock.restore();
});

function post(payload: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: "/api/auth/approval-reply",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    payload,
  });
}

function exactPayload(approvalId: string, threadId: string, laneKey: string, verb = "once") {
  return {
    verb,
    approvalId,
    threadId,
    laneKey,
    mediaGenerationDigest: mediaGeneration.digest,
    mediaGenerationQuoteDigest: mediaGeneration.quoteDigest,
    mediaGenerationRevision: mediaGeneration.revision,
  };
}

async function postAndWaitForResume(
  payload: Record<string, unknown>,
  target: "ordinary" | "task" = "ordinary",
) {
  // Register before the request; HTTP completion can precede graph resume.
  const called = Promise.withResolvers<void>();
  if (target === "ordinary") ordinaryResumeCalled = called;
  else taskResumeCalled = called;
  const response = await post(payload);
  expect(response.statusCode).toBe(200);
  await called.promise;
  return response;
}

describe("D525 authenticated paid media approval echo", () => {
  test("restart-safely forwards a complete authenticated echo into the ordinary graph resume", async () => {
    const approvalId = "media-generation:ordinary";
    const threadId = "room:d525-ordinary";
    const laneKey = "room:d525-ordinary";
    await postAndWaitForResume(exactPayload(approvalId, threadId, laneKey));
    expect(resumeSpy).toHaveBeenCalledTimes(1);
    const args = resumeSpy.mock.calls[0]!;
    expect(args.slice(10, 15)).toEqual([
      approvalId,
      mediaGeneration.digest,
      mediaGeneration.quoteDigest,
      laneKey,
      mediaGeneration.revision,
    ]);
  });

  test("fails closed for partial, malformed, or broadened media echoes", async () => {
    const approvalId = "media-generation:forgery";
    const threadId = "room:d525-forgery";
    const laneKey = "room:d525-forgery";
    const exact = exactPayload(approvalId, threadId, laneKey);
    for (const payload of [
      { ...exact, mediaGenerationDigest: undefined },
      { ...exact, mediaGenerationQuoteDigest: "not-a-digest" },
      { ...exact, mediaGenerationRevision: 2 },
      { ...exact, laneKey: undefined },
      { ...exact, verb: "room" },
    ]) {
      const response = await post(payload);
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: "approval_stale" });
    }
    expect(resumeSpy).not.toHaveBeenCalled();
  });

  test("does not infer authority from a prefix and forwards well-formed tampering only to checkpoint validation", async () => {
    const threadId = "room:d525-checkpoint";
    const laneKey = "room:d525-checkpoint";
    await postAndWaitForResume({
      verb: "once",
      approvalId: "media-generation:prefix-only",
      threadId,
      laneKey,
    });
    expect(resumeSpy.mock.calls[0]?.slice(10, 15)).toEqual([
      undefined, undefined, undefined, undefined, undefined,
    ]);

    const tamperedId = "ordinary-looking-id";
    const tampered = exactPayload(tamperedId, "room:d525-tampered", "room:d525-tampered");
    tampered.mediaGenerationDigest = "c".repeat(64);
    await postAndWaitForResume(tampered);
    expect(resumeSpy.mock.calls[1]?.slice(10, 15)).toEqual([
      tamperedId,
      "c".repeat(64),
      mediaGeneration.quoteDigest,
      "room:d525-tampered",
      1,
    ]);
  });

  test("threads the same exact five fields through deny on a Task lane", async () => {
    const approvalId = "media-generation:task";
    const threadId = "task-thread-d525";
    const laneKey = "task:d525-task";
    await postAndWaitForResume(exactPayload(approvalId, threadId, laneKey, "deny"), "task");
    expect(taskResumeSpy).toHaveBeenCalledTimes(1);
    expect(taskResumeSpy.mock.calls[0]?.[0]).toMatchObject({
      verb: "deny",
      mediaGenerationApprovalId: approvalId,
      mediaGenerationDigest: mediaGeneration.digest,
      mediaGenerationQuoteDigest: mediaGeneration.quoteDigest,
      mediaGenerationLaneKey: laneKey,
      mediaGenerationRevision: mediaGeneration.revision,
    });
  });
});
