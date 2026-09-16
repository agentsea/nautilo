/**
 * M063 — POST /api/auth/identity-verify-resume (Logto mid-session identity PIN).
 * PR review M-2 — branches + dispatch into `resumeGraphWithIdentity`.
 *
 * Mock isolation: import real `@nautilo/agent` and override only resume
 * helpers — partial mocks leak across files in one `bun test` process.
 */
import { describe, test, expect, afterEach, afterAll, mock } from "bun:test";

const unexpectedDatabaseAccess = mock(() => {
  throw new Error("Auth identity unit tests must not access a database");
});
mock.module("../../src/lib/server-direct-db", () => ({
  getServerDirectDb: unexpectedDatabaseAccess,
}));

// M125 Phase 2.8 — `resumeGraphWithIdentity` reordered args to
// (threadId, policyContext, agentId, processor, laneKey). The spy
// signature reflects the new order.
const resumeIdentitySpy = mock(
  async (
    _threadId: string,
    _pc: unknown,
    _agentId: string,
    _processor: unknown,
    _laneKey?: string,
  ) => {
    /* resolved by default */
  },
);

const realAgentIdentityResume = await import("@nautilo/agent");
mock.module("@nautilo/agent", () => ({
  ...realAgentIdentityResume,
  resumeGraphWithIdentity: resumeIdentitySpy,
  resumeGraphWithApproval: mock(async () => {}),
  resumeGraphWithAskReply: mock(async () => {}),
  readTurnIdForThread: mock(async () => "unit-test-turn-id"),
}));

const authorizeTaskApprovalResumeSpy = mock(async () => ({
  ok: true as const,
  task: {
    id: "identity-task",
    ownerId: "owner-user-id",
    requestorId: "owner-user-id",
    agentId: "task-agent",
    targetRoomId: null,
  },
  run: {
    id: "identity-task-run",
    graphThreadId: "identity-task-thread",
  },
}));
const runTaskApprovalResumeSpy = mock(async () => ({ reparked: false }));
const resumedMemoryDepsValue = Object.freeze({ source: "fresh-protected-resume" });
const resolveForegroundProtectedMemoryGraphDepsSpy = mock(
  async () => resumedMemoryDepsValue,
);
const realRuntime = await import("@nautilo/runtime");
mock.module("@nautilo/runtime", () => ({
  ...realRuntime,
  authorizeTaskApprovalResume: authorizeTaskApprovalResumeSpy,
  runTaskApprovalResume: runTaskApprovalResumeSpy,
  resolveForegroundProtectedMemoryGraphDeps:
    resolveForegroundProtectedMemoryGraphDepsSpy,
}));

const realTrust = await import("@nautilo/trust");
mock.module("@nautilo/trust", () => ({
  ...realTrust,
  generateRecoveryCodes: mock(async () => ["recovery-code-identity-test"]),
}));

import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { LockoutError, setBootstrapDefaultAgentId } from "@nautilo/trust";
import { authRoutes } from "../../src/routes/auth";
import {
  installProductionLiveShadowMessageComposition,
  uninstallProductionLiveShadowMessageComposition,
} from "../../src/routes/live-shadow-message-composition";
import { SessionStore } from "../helpers/test-session-store";
import { installLocalAuthPreHandlerStub } from "../unit/helpers/auth-preHandler-stub";

const OWNER_ACTOR_ID = "owner-actor-id";
const OWNER_ID = "owner-user-id";
const VALID_PIN = "654321";

async function waitForCallCount(
  readCount: () => number,
  expected: number,
): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (readCount() < expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const fakePinOk = {
  async isEnrolled() {
    return true;
  },
  async verifyProof(_uid: string, proof: string) {
    return proof === VALID_PIN;
  },
  async enroll() {
    throw new Error("unexpected enroll");
  },
  async changePin() {
    throw new Error("unexpected changePin");
  },
};

function makeLockoutPinProvider() {
  return {
    async isEnrolled() {
      return true;
    },
    async verifyProof() {
      throw new LockoutError(5000);
    },
    async enroll() {
      throw new Error("unexpected enroll");
    },
    async changePin() {
      throw new Error("unexpected changePin");
    },
  };
}

describe("POST /api/auth/identity-verify-resume", () => {
  afterEach(() => {
    setBootstrapDefaultAgentId("");
    resumeIdentitySpy.mockClear();
    resumeIdentitySpy.mockImplementation(async () => {});
    authorizeTaskApprovalResumeSpy.mockClear();
    runTaskApprovalResumeSpy.mockClear();
    resolveForegroundProtectedMemoryGraphDepsSpy.mockClear();
  });

  async function makeLogtoHarness(options?: {
    /** Defaults to `fakePinOk`. */
    pinProvider?: unknown;
    guestOverlay?: boolean;
    protectedResume?: "execute" | "fail";
  }): Promise<{
    app: FastifyInstance;
    token: string;
    runAgentTurnCalls: Array<Record<string, unknown>>;
    buildEnvelopeCalls: Array<readonly [string, string, string, string | undefined]>;
  }> {
    const sessionStore = new SessionStore(undefined, { persistPath: null });
    const app = Fastify({ logger: false });
    installLocalAuthPreHandlerStub(app, sessionStore);
    if (options?.guestOverlay) {
      app.addHook("preHandler", (request, _reply, done) => {
        if (request.headers["x-test-force-guest-role"] === "1") {
          request.policyContext = {
            actorRole: "guest",
            actorId: "guest",
          } as typeof request.policyContext;
        }
        done();
      });
    }
    const session = sessionStore.createSession(
      OWNER_ACTOR_ID,
      OWNER_ID,
      OWNER_ID,
    );
    const roomId = "40000000-0000-4000-8000-000000000322";
    const buildEnvelopeCalls: Array<
      readonly [string, string, string, string | undefined]
    > = [];
    authRoutes(app, {
      pinProvider: (options?.pinProvider ?? fakePinOk) as never,
      ownerActorId: OWNER_ACTOR_ID,
      ownerId: OWNER_ID,
      assertCanInvokeAgent: async () => undefined,
      resumeThreadMembershipForUser: async () => true,
      resumeThreadScopeForUser: async () => ({ roomId, kind: "direct" }),
      resumeAgentIdForThread: async () => options?.protectedResume === undefined
        ? null
        : "resumed-agent",
      policyResolver: {
        buildEnvelope: async (
          actorId: string,
          laneKey: string,
          agentId: string,
          requestedRoomId?: string,
        ) => {
          buildEnvelopeCalls.push([actorId, laneKey, agentId, requestedRoomId]);
          return {
            memoryMode: "namespace",
            ownerId: OWNER_ID,
            actorId,
            agentId,
            roomId: requestedRoomId ?? "",
            readableNamespaces: [`lane:${laneKey}`],
            mutableNamespaces: [`lane:${laneKey}`],
            writableNamespaces: [`lane:${laneKey}`],
            toolPolicy: {},
          };
        },
      } as never,
      // Identity-resume route tests are intentionally about ordinary/Fallback
      // dispatch. Make that policy explicit rather than consulting durable
      // process-global state through the production Strict boundary.
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
    });
    const runAgentTurnCalls: Array<Record<string, unknown>> = [];
    if (options?.protectedResume !== undefined) {
      installProductionLiveShadowMessageComposition(app, {
        reserveSharedAgentRuntimeResume: async () => ({
          status: "reserved",
          invocationId: "invocation-identity-resume",
          executionId: "60000000-0000-4000-8000-000000000322",
          roomId,
          agentId: "resumed-agent",
          invokingHumanId: OWNER_ACTOR_ID,
          sourceDeviceId: "device-source",
          authorizationDeviceId: "device-authorizer",
          clientActionSessionId: "session-identity",
          policyRevision: 1,
          deadlineAt: Date.now() + 60_000,
        }),
        planSharedAgentExecutionAuthorization: async () => ({
          status: "authorized",
          executionId: "60000000-0000-4000-8000-000000000322",
          executionKind: "resume",
          planBytes: new Uint8Array([1]),
          executionDeadlineAt: Date.now() + 60_000,
          sessionReference: "session-reference",
          authorizationDigest: new Uint8Array(32),
          scope: {
            subjectHumanId: OWNER_ACTOR_ID,
            issuingDeviceId: "device-authorizer",
            recipientKind: "nautilo_foreground_runtime",
            browserSessionId: "session-identity",
            topLevelRoomId: roomId,
            policyRevision: 1,
            hostAuthorizationRevision: 1,
            namespaceIds: [],
            grantDomainIds: [],
            domainAuthoritySetDigest: new Uint8Array(32),
          },
        }),
        awaitSharedAgentExecutionAuthorization: async () => null,
        runAgentTurn: async (input: Record<string, unknown>) => {
          runAgentTurnCalls.push(input);
          if (options.protectedResume === "fail") {
            return { status: "fallback", reason: "integrity_failure" };
          }
          const work = input["work"] as (session: object) => Promise<unknown>;
          return { status: "executed", value: await work({}) };
        },
      } as never);
    }
    app.addHook("onClose", () => {
      uninstallProductionLiveShadowMessageComposition(app);
    });
    await app.ready();
    return { app, token: session.token, runAgentTurnCalls, buildEnvelopeCalls };
  }

  test("without Bearer → 401", async () => {
    const { app } = await makeLogtoHarness();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/identity-verify-resume",
      headers: { "Content-Type": "application/json" },
      payload: { pin: VALID_PIN, threadId: "t1" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  test("does not use the legacy guest Role shortcut when Capability admission allows", async () => {
    const { app, token } = await makeLogtoHarness({ guestOverlay: true });
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/identity-verify-resume",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "x-test-force-guest-role": "1",
      },
      payload: { pin: VALID_PIN, threadId: "t1" },
    });
    expect(res.statusCode).toBe(200);
    await waitForCallCount(() => resumeIdentitySpy.mock.calls.length, 1);
    expect(resumeIdentitySpy).toHaveBeenCalledTimes(1);
    await app.close();
  });

  test("missing pin → 400", async () => {
    const { app, token } = await makeLogtoHarness();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/identity-verify-resume",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      payload: { threadId: "t1" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  test("missing threadId → 400", async () => {
    const { app, token } = await makeLogtoHarness();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/identity-verify-resume",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      payload: { pin: VALID_PIN },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  test("invalid PIN → 401; resume not dispatched", async () => {
    const { app, token } = await makeLogtoHarness();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/identity-verify-resume",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      payload: { pin: "000000", threadId: "t-bad" },
    });
    expect(res.statusCode).toBe(401);
    expect(resumeIdentitySpy).not.toHaveBeenCalled();
    await app.close();
  });

  test("happy path → 200; resumeGraphWithIdentity receives ids + laneKey + agentId (envelope-derived, M125)", async () => {
    // M125 Phase 2.4 — agentId now comes from `request.memoryEnvelope.agentId`,
    // not the bootstrap default. The stub stamps `"stub-envelope-agent"`
    // unless `agentIdForSession` overrides.
    setBootstrapDefaultAgentId("env-default-agent");

    const { app, token } = await makeLogtoHarness();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/identity-verify-resume",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      payload: {
        pin: VALID_PIN,
        threadId: "thread-happy",
        laneKey: "lane-custom",
      },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
    await waitForCallCount(() => resumeIdentitySpy.mock.calls.length, 1);
    expect(resumeIdentitySpy).toHaveBeenCalledTimes(1);

    // M125 Phase 2.8 — new arg order: (threadId, pc, agentId, processor, laneKey)
    const call = resumeIdentitySpy.mock.calls[0]!;
    expect(call[0]).toBe("thread-happy");
    expect(call[1]).toMatchObject({
      actorRole: "owner",
      actorId: OWNER_ACTOR_ID,
    });
    expect(call[2]).toBe("stub-envelope-agent");
    expect(call[4]).toBe("lane-custom");

    const processor = call[3] as {
      process?: unknown;
      flush?: unknown;
      emit?: unknown;
    };
    expect(typeof processor.process).toBe("function");
    expect(typeof processor.flush).toBe("function");
    expect(typeof processor.emit).toBe("function");

    await app.close();
  });

  test("identity verification rebuilds protected Memory deps inside the authorized resume", async () => {
    const h = await makeLogtoHarness({ protectedResume: "execute" });
    const res = await h.app.inject({
      method: "POST",
      url: "/api/auth/identity-verify-resume",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${h.token}`,
      },
      payload: {
        pin: VALID_PIN,
        threadId: "thread-protected-identity",
        laneKey: "room:protected-identity",
        clientActionSessionId: "session-identity",
        authorizationDeviceId: "device-authorizer",
      },
    });

    expect(res.statusCode).toBe(200);
    await waitForCallCount(() => resumeIdentitySpy.mock.calls.length, 1);
    const call = resumeIdentitySpy.mock.calls[0] as unknown as unknown[];
    expect(call[0]).toBe("thread-protected-identity");
    expect(call[2]).toBe("resumed-agent");
    expect(call[4]).toBe("room:protected-identity");
    expect(call[7]).toBeInstanceOf(AbortSignal);
    expect(call[9]).toBe(resumedMemoryDepsValue);
    expect(h.buildEnvelopeCalls).toEqual([[
      OWNER_ACTOR_ID,
      "room:protected-identity",
      "resumed-agent",
      "40000000-0000-4000-8000-000000000322",
    ]]);
    expect(resolveForegroundProtectedMemoryGraphDepsSpy).toHaveBeenCalledTimes(1);
    expect(h.runAgentTurnCalls).toHaveLength(1);
    await h.app.close();
  });

  test("PIN enrollment rebuilds protected Memory deps inside the authorized resume", async () => {
    const pinProvider = {
      ...fakePinOk,
      async isEnrolled() {
        return false;
      },
      async enroll() {
        // The enrollment mutation is deliberately in-memory in this route test.
      },
    };
    const h = await makeLogtoHarness({ pinProvider, protectedResume: "execute" });
    const res = await h.app.inject({
      method: "POST",
      url: "/api/auth/pin",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${h.token}`,
      },
      payload: {
        newPin: "246802",
        threadId: "thread-protected-enrollment",
        laneKey: "room:protected-enrollment",
        clientActionSessionId: "session-identity",
        authorizationDeviceId: "device-authorizer",
      },
    });

    expect(res.statusCode).toBe(200);
    await waitForCallCount(() => resumeIdentitySpy.mock.calls.length, 1);
    const call = resumeIdentitySpy.mock.calls[0] as unknown as unknown[];
    expect(call[0]).toBe("thread-protected-enrollment");
    expect(call[2]).toBe("resumed-agent");
    expect(call[4]).toBe("room:protected-enrollment");
    expect(call[7]).toBeInstanceOf(AbortSignal);
    expect(call[9]).toBe(resumedMemoryDepsValue);
    expect(h.buildEnvelopeCalls).toEqual([[
      OWNER_ACTOR_ID,
      "room:protected-enrollment",
      "resumed-agent",
      "40000000-0000-4000-8000-000000000322",
    ]]);
    expect(resolveForegroundProtectedMemoryGraphDepsSpy).toHaveBeenCalledTimes(1);
    expect(h.runAgentTurnCalls).toHaveLength(1);
    await h.app.close();
  });

  test("identity verification never falls back to ordinary resume after protected failure", async () => {
    const h = await makeLogtoHarness({ protectedResume: "fail" });
    const res = await h.app.inject({
      method: "POST",
      url: "/api/auth/identity-verify-resume",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${h.token}`,
      },
      payload: {
        pin: VALID_PIN,
        threadId: "thread-protected-failure",
        laneKey: "room:protected-failure",
        clientActionSessionId: "session-identity",
        authorizationDeviceId: "device-authorizer",
      },
    });

    expect(res.statusCode).toBe(200);
    await waitForCallCount(() => h.runAgentTurnCalls.length, 1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.runAgentTurnCalls).toHaveLength(1);
    expect(resumeIdentitySpy).not.toHaveBeenCalled();
    expect(resolveForegroundProtectedMemoryGraphDepsSpy).not.toHaveBeenCalled();
    await h.app.close();
  });

  test("laneKey omitted → falls back to threadId", async () => {
    const { app, token } = await makeLogtoHarness();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/identity-verify-resume",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      payload: { pin: VALID_PIN, threadId: "thread-fallback-lane" },
    });
    expect(res.statusCode).toBe(200);
    await waitForCallCount(() => resumeIdentitySpy.mock.calls.length, 1);
    const call = resumeIdentitySpy.mock.calls[0]!;
    expect(call[4]).toBe("thread-fallback-lane");
    await app.close();
  });

  test("Task identity verification uses the dual-subject Task resume path", async () => {
    const { app, token } = await makeLogtoHarness();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/identity-verify-resume",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      payload: {
        pin: VALID_PIN,
        threadId: "identity-task-thread",
        laneKey: "task:identity-task",
      },
    });

    expect(res.statusCode).toBe(200);
    const authCall = authorizeTaskApprovalResumeSpy.mock.calls[0] as unknown as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(authCall[0]).toEqual({
      taskId: "identity-task",
      threadId: "identity-task-thread",
      sessionUserId: OWNER_ID,
    });
    expect(typeof authCall[1]["assertInvocation"]).toBe("function");
    const resumeCall = runTaskApprovalResumeSpy.mock.calls[0] as unknown as [
      Record<string, unknown>,
    ];
    expect(resumeCall[0]["kind"]).toBe("identity");
    expect(typeof resumeCall[0]["invocationAuthority"]).toBe("object");
    expect(typeof resumeCall[0]["maintenanceAuthority"]).toBe("object");
    expect(resumeIdentitySpy).not.toHaveBeenCalled();
    await app.close();
  });

  test("M125 Phase 2.4 — missing envelope.agentId → 409 agent_id_required_to_resume; resume not dispatched", async () => {
    // Override the stub so the bearer session does NOT stamp an envelope
    // agentId, simulating a half-bound user (valid JWT, zero owned agents).
    const sessionStore = new SessionStore(undefined, { persistPath: null });
    const app = Fastify({ logger: false });
    installLocalAuthPreHandlerStub(app, sessionStore, {
      agentIdForSession: () => "", // empty → 409
    });
    const session = sessionStore.createSession(
      OWNER_ACTOR_ID,
      OWNER_ID,
      OWNER_ID,
    );
    authRoutes(app, {
      pinProvider: fakePinOk as never,
      ownerActorId: OWNER_ACTOR_ID,
      ownerId: OWNER_ID,
      assertCanInvokeAgent: async () => undefined,
      resumeThreadMembershipForUser: async () => true,
    });
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/identity-verify-resume",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.token}`,
      },
      payload: { pin: VALID_PIN, threadId: "t-half-bound" },
    });

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body) as { code?: string };
    expect(body.code).toBe("agent_id_required_to_resume");
    expect(resumeIdentitySpy).not.toHaveBeenCalled();

    await app.close();
  });

  test("LockoutError → 429 with retryAfterMs", async () => {
    const { app, token } = await makeLogtoHarness({
      pinProvider: makeLockoutPinProvider(),
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/identity-verify-resume",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      payload: { pin: VALID_PIN, threadId: "t-lock" },
    });

    expect(res.statusCode).toBe(429);
    const body: { retryAfterMs?: number } = res.json();
    expect(body.retryAfterMs).toBe(5000);
    expect(resumeIdentitySpy).not.toHaveBeenCalled();

    await app.close();
  });
});

afterAll(() => {
  expect(unexpectedDatabaseAccess).not.toHaveBeenCalled();
  mock.restore();
});
