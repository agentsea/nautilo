/**
 * M085 MAJOR #2 — fork resume routing.
 *
 * The auth resume routes must:
 *   - authorize membership against the PARENT graph thread id
 *     (`parentGraphThreadIdFromForkCheckpoint(threadId)`),
 *   - call `resumeGraphWith*` with the FORK checkpoint thread id verbatim,
 *   - construct the persisting processor with the PARENT transcript thread,
 *   - call `forkCoordinator.markForkCompletedByCheckpoint(forkThreadId)` after
 *     the resume settles (M170 — replaced the deleted splice `finalize` path;
 *     advances lane ordering, no checkpoint splice).
 */
import { describe, test, expect, beforeAll, afterAll, mock, spyOn } from "bun:test";

const unexpectedDatabaseAccess = mock(() => {
  throw new Error("Auth routing unit tests must not access a database");
});
mock.module("../../src/lib/server-direct-db", () => ({
  getServerDirectDb: unexpectedDatabaseAccess,
}));

type ResumeAskFn = (
  threadId: string,
  verb: string,
  processor: unknown,
  laneKey: string,
  ...rest: unknown[]
) => Promise<void>;
type ResumeApprovalFn = (
  threadId: string,
  approved: boolean,
  processor: unknown,
  laneKey: string,
  ...rest: unknown[]
) => Promise<void>;
type ResumeIdentityFn = (
  threadId: string,
  ...rest: unknown[]
) => Promise<void>;

const resumeAskSpy = mock<ResumeAskFn>(async () => {});
const resumeApprovalSpy = mock<ResumeApprovalFn>(async () => {});
const resumeIdentitySpy = mock<ResumeIdentityFn>(async () => {});

// Spread-and-override pattern: keep every other export from @nautilo/agent
// and @nautilo/runtime intact. `mock.module` is process-wide, so a sparse
// override would leak into sibling test files that depend on the real
// `eventBus` (e.g. posture-mutator's `policy.changed` listener and
// approval-reply-dispatch's `approval.ask` -> network-context map). CI
// happens to order us before those tests; locally it didn't, which is
// how a previous version of this file shipped.
mock.module("@nautilo/agent", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const real = require("@nautilo/agent") as Record<string, unknown>;
  return {
    ...real,
    resumeGraphWithAskReply: resumeAskSpy,
    resumeGraphWithApproval: resumeApprovalSpy,
    resumeGraphWithIdentity: resumeIdentitySpy,
    readTurnIdForThread: mock(async () => "test-turn-id"),
    // Legacy approval resumes have no active D476 projection binding.
    readProjectionResumeBindingForThread: mock(async () => ({ kind: "none" as const })),
  };
});

const persistingProcessorSpy = mock<
  (opts: Record<string, unknown>) => { process: () => void; flush: () => void; emit: () => void }
>(() => ({ process: () => {}, flush: () => {}, emit: () => {} }));

mock.module("@nautilo/runtime", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const real = require("@nautilo/runtime") as Record<string, unknown>;
  return {
    ...real,
    createPersistingProcessor: persistingProcessorSpy,
  };
});

import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { PinChallengeProvider } from "@nautilo/trust";
import { forkCoordinator } from "@nautilo/runtime";
import { authRoutes } from "../../src/routes/auth";
import { SessionStore } from "../helpers/test-session-store";
import { installLocalAuthPreHandlerStub } from "../unit/helpers/auth-preHandler-stub";
import { installResumeInvocationAuthority } from "../helpers/resume-invocation-authority";

// M170 — spy on the real singleton (no module override; markForkCompletedByCheckpoint
// no-ops for an unknown/non-fork thread, so calling it in the test is safe).
const markSpy = spyOn(forkCoordinator, "markForkCompletedByCheckpoint");

let app: FastifyInstance;
let sessionStore: SessionStore;
let validToken: string;
const membershipChecks: Array<{ threadId: string; userId: string }> = [];

const OWNER_ACTOR_ID = "test-actor-id";
const OWNER_ID = "test-owner-id";
const PARENT_THREAD = "room:abc";
const FORK_THREAD = `${PARENT_THREAD}:fork:turn-xyz:7f3a`;
const SUBTHREAD_ROOM_ID = "subthread-room-id";
let resumeRoomKind = "subthread";

async function waitForCallCount(
  readCount: () => number,
  expected: number,
): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (readCount() < expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

beforeAll(async () => {
  await installResumeInvocationAuthority(OWNER_ID);
  sessionStore = new SessionStore(undefined, { persistPath: null });
  app = Fastify({ logger: false });
  installLocalAuthPreHandlerStub(app, sessionStore);
  authRoutes(app, {
    pinProvider: new PinChallengeProvider({ persistPath: null }),
    ownerActorId: OWNER_ACTOR_ID,
    ownerId: OWNER_ID,
    assertCanInvokeAgent: async () => undefined,
    resumeThreadMembershipForUser: async (threadId, userId) => {
      membershipChecks.push({ threadId, userId });
      return true;
    },
    resumeCausalHumanUserIdForThread: async () => OWNER_ID,
    resumeThreadScopeForUser: async () => ({
      roomId: SUBTHREAD_ROOM_ID,
      kind: resumeRoomKind,
    }),
    // These routing tests exercise the ordinary/Fallback resume path. Keep
    // the durable Strict-policy boundary explicit so they do not depend on a
    // database-backed process-global policy from another test.
    strictShadowPolicyReader: async () => ({
      mode: "shadow_encryption",
      shadowBehavior: "fallback",
      revision: 1,
      shadowEncryptionStartedAt: null,
      updatedAt: new Date(0),
    }),
    strictShadowBoundaryEnforcer: async (input) => ({
      policy: {
        id: "server",
        mode: "shadow_encryption",
        shadowBehavior: "fallback",
        revision: 1,
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
    } as never),
    auditEvent: () => Promise.resolve(),
  });
  await app.ready();
  const session = sessionStore.createSession(OWNER_ACTOR_ID, OWNER_ID, OWNER_ID);
  validToken = session.token;
});

afterAll(async () => {
  if (app) await app.close();
  expect(unexpectedDatabaseAccess).not.toHaveBeenCalled();
});

describe("auth resume routes — fork thread routing (M085)", () => {
  test("approval-reply: membership keyed by parent thread; resume passes fork thread; markForkCompletedByCheckpoint sees fork thread", async () => {
    resumeAskSpy.mockClear();
    markSpy.mockClear();
    persistingProcessorSpy.mockClear();
    membershipChecks.length = 0;

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/approval-reply",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${validToken}`,
      },
      payload: { verb: "once", threadId: FORK_THREAD },
    });

    expect(res.statusCode).toBe(200);
    await waitForCallCount(() => markSpy.mock.calls.length, 1);

    expect(membershipChecks).toHaveLength(1);
    expect(membershipChecks[0]?.threadId).toBe(PARENT_THREAD);

    expect(resumeAskSpy).toHaveBeenCalledTimes(1);
    expect(resumeAskSpy.mock.calls[0]![0]).toBe(FORK_THREAD);
    const memoryDeps = resumeAskSpy.mock.calls[0]![16] as Record<string, unknown>;
    expect(typeof memoryDeps["fullEncryptionOnlyForState"]).toBe("function");
    expect(memoryDeps["protectedMemoryRepositoryForState"]).toBeUndefined();
    expect(memoryDeps["protectedMemoryAccessPortForState"]).toBeUndefined();
    expect(memoryDeps["protectedMemoryProjectionPortForState"]).toBeUndefined();

    expect(persistingProcessorSpy).toHaveBeenCalledTimes(1);
    const procOpts = persistingProcessorSpy.mock.calls[0]![0] as { threadId: string };
    expect(procOpts.threadId).toBe(PARENT_THREAD);
    expect(procOpts).toMatchObject({
      roomId: SUBTHREAD_ROOM_ID,
      subthreadRoomId: SUBTHREAD_ROOM_ID,
    });

    expect(markSpy).toHaveBeenCalledTimes(1);
    expect(markSpy.mock.calls[0]![0]).toBe(FORK_THREAD);
  });

  test("prove-and-resume: same fork-thread routing contract", async () => {
    resumeApprovalSpy.mockClear();
    markSpy.mockClear();
    persistingProcessorSpy.mockClear();
    membershipChecks.length = 0;

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/prove-and-resume",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${validToken}`,
      },
      payload: { denied: true, threadId: FORK_THREAD },
    });

    expect(res.statusCode).toBe(200);
    await waitForCallCount(() => markSpy.mock.calls.length, 1);

    expect(membershipChecks[0]?.threadId).toBe(PARENT_THREAD);
    expect(resumeApprovalSpy).toHaveBeenCalledTimes(1);
    expect(resumeApprovalSpy.mock.calls[0]![0]).toBe(FORK_THREAD);
    const memoryDeps = resumeApprovalSpy.mock.calls[0]![7] as Record<string, unknown>;
    expect(typeof memoryDeps["fullEncryptionOnlyForState"]).toBe("function");
    expect(memoryDeps["protectedMemoryRepositoryForState"]).toBeUndefined();
    expect(memoryDeps["protectedMemoryAccessPortForState"]).toBeUndefined();
    expect(memoryDeps["protectedMemoryProjectionPortForState"]).toBeUndefined();
    const procOpts = persistingProcessorSpy.mock.calls[0]![0] as { threadId: string };
    expect(procOpts.threadId).toBe(PARENT_THREAD);
    expect(markSpy).toHaveBeenCalledTimes(1);
    expect(markSpy.mock.calls[0]![0]).toBe(FORK_THREAD);
  });

  test("non-fork threads still flow normally (no `:fork:` segment)", async () => {
    resumeAskSpy.mockClear();
    markSpy.mockClear();
    persistingProcessorSpy.mockClear();
    membershipChecks.length = 0;

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/approval-reply",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${validToken}`,
      },
      payload: { verb: "room", threadId: PARENT_THREAD },
    });

    expect(res.statusCode).toBe(200);
    await waitForCallCount(() => markSpy.mock.calls.length, 1);

    expect(membershipChecks[0]?.threadId).toBe(PARENT_THREAD);
    expect(resumeAskSpy.mock.calls[0]![0]).toBe(PARENT_THREAD);
    const procOpts = persistingProcessorSpy.mock.calls[0]![0] as { threadId: string };
    expect(procOpts.threadId).toBe(PARENT_THREAD);
    // markForkCompletedByCheckpoint is still called, but with the same id; it
    // no-ops internally when the id maps to no registered fork.
    expect(markSpy.mock.calls[0]![0]).toBe(PARENT_THREAD);
  });

  test("ordinary resolved rooms pass roomId but never receive a child stamp", async () => {
    resumeAskSpy.mockClear();
    persistingProcessorSpy.mockClear();
    membershipChecks.length = 0;
    resumeRoomKind = "group";
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/approval-reply",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${validToken}`,
        },
        payload: { verb: "room", threadId: PARENT_THREAD },
      });

      expect(res.statusCode).toBe(200);
      await waitForCallCount(() => resumeAskSpy.mock.calls.length, 1);
      expect(resumeAskSpy).toHaveBeenCalledTimes(1);
      const procOpts = persistingProcessorSpy.mock.calls[0]![0];
      expect(procOpts["roomId"]).toBe(SUBTHREAD_ROOM_ID);
      expect(procOpts["subthreadRoomId"]).toBeUndefined();
    } finally {
      resumeRoomKind = "subthread";
    }
  });
});
