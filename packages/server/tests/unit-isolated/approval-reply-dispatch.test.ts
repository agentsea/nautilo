/**
 * D061 PR #58 follow-up M-4 — route→graph dispatch test.
 *
 * Mock isolation: import real `@nautilo/agent` and override only resume
 * helpers — partial mocks leak across files in one `bun test` process.
 *
 * The existing `approval-reply.test.ts` covers HTTP validation
 * (400/401/200 statuses) but doesn't actually verify that a 200 reply
 * triggers `resumeGraphWithAskReply(threadId, verb, processor)`. This
 * file mocks `@nautilo/agent` so we can spy on the resume call
 * directly, plus lock in the fire-and-forget error-handling semantic
 * (a throw from the resume doesn't bubble up to the HTTP response).
 *
 * Implementation note: `mock.module` must be evaluated BEFORE the
 * module under test imports `@nautilo/agent`. Bun evaluates
 * top-level statements in source order; the mock call is placed
 * before the first import that transitively loads `@nautilo/agent`.
 */
import { describe, test, expect, beforeAll, afterAll, mock, spyOn } from "bun:test";

type ResumeFn = (
  threadId: string,
  verb: string,
  processor: unknown,
  laneKey: string,
  checkpointSaver?: unknown,
  signal?: unknown,
  approvalId?: string,
  digest?: string,
  localMcpInstallLaneKey?: string,
  sshPrepareApprovalId?: string,
  mediaApprovalId?: string,
  mediaDigest?: string,
  mediaQuoteDigest?: string,
  mediaLaneKey?: string,
  mediaRevision?: number,
  liveShadowToolBoundaryForState?: () => unknown,
  invocationMemoryDeps?: Record<string, unknown>,
  expectedApprovalId?: string,
) => Promise<void>;
type HostChoiceResumeFn = (
  threadId: string,
  choice: { choiceId: string; selector: string },
  processor: unknown,
  laneKey: string,
) => Promise<void>;
type ConnectedWebActionResumeFn = (
  threadId: string,
  reply: { toolCallId: string; decision: "done" | "cancel" },
  intervention: unknown,
  userId: string,
  processor: unknown,
  laneKey?: string,
  checkpointSaver?: unknown,
  signal?: unknown,
  liveShadowToolBoundaryForState?: () => unknown,
) => Promise<void>;
type ApprovalResumeFn = (
  threadId: string,
  approved: boolean,
  processor: unknown,
  laneKey: string,
  checkpointSaver?: unknown,
  signal?: unknown,
  liveShadowToolBoundaryForState?: () => unknown,
  invocationMemoryDeps?: Record<string, unknown>,
  expectedChallengeId?: string,
) => Promise<void>;

const resumeSpy = mock<ResumeFn>(async () => {
  /* default: resolve silently */
});
const approvalResumeSpy = mock<ApprovalResumeFn>(async () => {});
const hostChoiceResumeSpy = mock<HostChoiceResumeFn>(async () => {});
const connectedWebActionResumeSpy = mock<ConnectedWebActionResumeFn>(async () => {});

const realAgentApprovalReply = await import("@nautilo/agent");
mock.module("@nautilo/agent", () => ({
  ...realAgentApprovalReply,
  resumeGraphWithAskReply: resumeSpy,
  resumeGraphWithHostChoice: hostChoiceResumeSpy,
  resumeGraphWithConnectedWebAction: connectedWebActionResumeSpy,
  resumeGraphWithApproval: approvalResumeSpy,
  resumeGraphWithIdentity: mock(async () => {}),
  readTurnIdForThread: mock(async () => "test-turn-id"),
  // Legacy approval replies have no active D476 projection binding.
  readProjectionResumeBindingForThread: mock(async () => ({ kind: "none" as const })),
}));

// NOTE: these imports appear AFTER the `mock.module(...)` call above —
// that ordering is intentional (mock.module must be evaluated before
// any import transitively loads `@nautilo/agent`). The `import/first`
// lint rule isn't configured in this project so no disable comment
// is needed; if it gets enabled later this file needs its own
// exception.
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import {
  PinChallengeProvider,
  type NamespaceMemoryEnvelope,
} from "@nautilo/trust";
import { authRoutes } from "../../src/routes/auth";
import { SessionStore } from "../helpers/test-session-store";
import { installLocalAuthPreHandlerStub } from "../unit/helpers/auth-preHandler-stub";
import { installResumeInvocationAuthority } from "../helpers/resume-invocation-authority";
import {
  eventBus,
  getCurrentLiveShadowTurnContext,
  jobManager,
} from "@nautilo/runtime";
import type { ServerEvent } from "@nautilo/types";
import type { SecurityAuditEvent } from "../../src/lib/security-audit-log";
import {
  installProductionLiveShadowMessageComposition,
  uninstallProductionLiveShadowMessageComposition,
  type ProductionLiveShadowMessageComposition,
} from "../../src/routes/live-shadow-message-composition";

let app: FastifyInstance;
let sessionStore: SessionStore;
let validToken: string;
let auditEvents: SecurityAuditEvent[];
let shadowBehavior: "fallback" | "strict" = "fallback";
let encryptionMode: "shadow_encryption" | "encrypted_only" = "shadow_encryption";
let invokedAgentIds: string[] = [];

const OWNER_ACTOR_ID = "test-actor-id";
const OWNER_ID = "test-owner-id";
const SAMPLE_AGENT_ID = "00000000-0000-4000-8000-000000000002";
const SAMPLE_APPROVAL_THREAD = "room:10000000-0000-4000-8000-000000000001:bot:00000000-0000-4000-8000-000000000002";
const CONNECTED_WEB_ROOM_ID = "11111111-1111-4111-8111-111111111111";
const RESUME_ROOM_ID = "33333333-3333-4333-8333-333333333333";
const CONNECTED_WEB_THREAD_ID = `room:${CONNECTED_WEB_ROOM_ID}:user:${OWNER_ACTOR_ID}:bot:originating-agent`;
const CONNECTED_WEB_LANE_KEY = `room:${CONNECTED_WEB_ROOM_ID}:bot:originating-agent`;
let connectedWebCheckpointBinding = { agentId: "originating-agent", laneKey: CONNECTED_WEB_LANE_KEY };
const canonicalEnvelopeFor = (
  actorId: string,
  agentId: string,
  roomId = "",
): NamespaceMemoryEnvelope => ({
  ownerId: OWNER_ID,
  actorId,
  agentId,
  roomId,
  readableNamespaces: ["namespace-unit"],
  mutableNamespaces: ["namespace-unit"],
  writableNamespaces: ["namespace-unit"],
  toolPolicy: {},
});
type BuildEnvelopeFn = (
  actorId: string,
  laneKey: string,
  agentId: string,
  roomId?: string,
) => Promise<NamespaceMemoryEnvelope>;
const buildEnvelopeSpy = mock<BuildEnvelopeFn>(async (
  actorId,
  _laneKey,
  agentId,
  roomId,
) => canonicalEnvelopeFor(actorId, agentId, roomId));
const CONNECTED_WEB_ATTENTION = {
  type: "connected_web.action_attention" as const,
  threadId: CONNECTED_WEB_THREAD_ID,
  laneKey: CONNECTED_WEB_LANE_KEY,
  toolCallId: "connected-web-tool",
  userId: OWNER_ID,
  intervention: {
    kind: "authentication_required" as const,
    mode: "reconnect" as const,
    reason: "mfa" as const,
    account: {
      id: "22222222-2222-4222-8222-222222222222",
      label: "Nebius",
      service: "Nebius",
      origin: "https://console.nebius.com",
    },
  },
};
const CONNECTED_WEB_RACE_ATTENTION = { ...CONNECTED_WEB_ATTENTION, toolCallId: "connected-web-tool-race" };
const CONNECTED_WEB_FAILED_ATTENTION = { ...CONNECTED_WEB_ATTENTION, toolCallId: "connected-web-tool-failed" };
const CONNECTED_WEB_DOUBLE_FAILED_ATTENTION = { ...CONNECTED_WEB_ATTENTION, toolCallId: "connected-web-tool-double-failed" };

const protectedResumeReservation = (executionId: string) => ({
  status: "reserved" as const,
  invocationId: `resume:${executionId}`,
  executionId,
  roomId: RESUME_ROOM_ID,
  agentId: "stub-envelope-agent",
  invokingHumanId: OWNER_ACTOR_ID,
  sourceDeviceId: "source-device",
  authorizationDeviceId: "approving-device",
  clientActionSessionId: "browser-session",
  policyRevision: 1,
  deadlineAt: Date.now() + 30_000,
});

const authorizedProtectedResumePlan = (executionId: string) => ({
  status: "authorized" as const,
  executionId,
  executionKind: "resume" as const,
  planBytes: new Uint8Array([1]),
  sessionReference: "runtime-session",
  authorizationDigest: new Uint8Array(32).fill(1),
  scope: {
    subjectHumanId: OWNER_ACTOR_ID,
    issuingDeviceId: "approving-device",
    recipientKind: "nautilo_foreground_runtime" as const,
    browserSessionId: "browser-session",
    topLevelRoomId: RESUME_ROOM_ID,
    policyRevision: 1,
    hostAuthorizationRevision: 1,
    namespaceIds: ["namespace-unit"],
    grantDomainIds: ["domain-unit"],
    domainAuthoritySetDigest: new Uint8Array(32).fill(2),
  },
});

beforeAll(async () => {
  await installResumeInvocationAuthority(OWNER_ID);
  sessionStore = new SessionStore(undefined, { persistPath: null });
  auditEvents = [];

  app = Fastify({ logger: false });
  // M052 — auth decoration moved to the global preHandler.
  installLocalAuthPreHandlerStub(app, sessionStore);
  authRoutes(app, {
    pinProvider: new PinChallengeProvider({ persistPath: null }),
    ownerActorId: OWNER_ACTOR_ID,
    ownerId: OWNER_ID,
    assertCanInvokeAgent: async (input) => {
      if (input.agentId) invokedAgentIds.push(input.agentId);
    },
    strictShadowPolicyReader: async () => ({
      id: "server",
      mode: encryptionMode,
      shadowBehavior,
      revision: 1,
    } as never),
    strictShadowBoundaryEnforcer: async (input) => ({
      policy: {
        id: "server",
        mode: encryptionMode,
        shadowBehavior,
        revision: 1,
      },
      result: {
        disposition: shadowBehavior === "strict" ? "reject" : "ordinary",
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
    resumeThreadMembershipForUser: async () => true,
    resumeThreadScopeForUser: async () => ({
      roomId: RESUME_ROOM_ID,
      kind: "group",
    }),
    resumeCausalHumanUserIdForThread: async () => OWNER_ID,
    policyResolver: {
      buildEnvelope: buildEnvelopeSpy,
    } as never,
    resumeAgentIdForThread: async (threadId) =>
      threadId === SAMPLE_APPROVAL_THREAD ? SAMPLE_AGENT_ID : null,
    connectedWebActionPendingForThread: async () => [CONNECTED_WEB_ATTENTION, CONNECTED_WEB_RACE_ATTENTION, CONNECTED_WEB_FAILED_ATTENTION, CONNECTED_WEB_DOUBLE_FAILED_ATTENTION],
    connectedWebActionResumeBindingForThread: async () => connectedWebCheckpointBinding,
    auditEvent: (event) => {
      auditEvents.push(event);
      return Promise.resolve();
    },
  });

  await app.ready();

  const session = sessionStore.createSession(OWNER_ACTOR_ID, OWNER_ID, OWNER_ID);
  validToken = session.token;
});

afterAll(async () => {
  if (app) await app.close();
  mock.restore();
});

describe("POST /api/auth/approval-reply — route→graph dispatch (M-4)", () => {
  test("audits server-bound network approval context after successful resume", async () => {
    resumeSpy.mockClear();
    auditEvents = [];
    eventBus.emit({
      type: "approval.ask",
      approvalId: "approval-net",
      threadId: "thread-net",
      laneKey: "lane-net",
      userId: OWNER_ID,
      reason: "Agent attempted network access to api.weather.com:443",
      reasonCode: "network-egress-denied",
      allowedVerbs: ["once", "room", "always", "deny"],
      tools: [],
      network: {
        host: "api.weather.com",
        port: 443,
        reason: "no allow rule matched",
        suggestedRule: {
          type: "domain",
          host: "api.weather.com",
          ports: [443],
        },
      },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/approval-reply",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${validToken}`,
        "User-Agent": "approval-test/1.0",
      },
      payload: {
        verb: "room",
        approvalId: "approval-net",
        threadId: "thread-net",
        laneKey: "lane-net",
        network: {
          host: "evil.example",
          port: 443,
          reason: "client supplied context should be ignored",
        },
      },
    });

    expect(res.statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      kind: "approval_granted",
      route: "POST /api/auth/approval-reply",
      threadId: "thread-net",
      laneKey: "lane-net",
      verb: "room",
      network: {
        host: "api.weather.com",
        port: 443,
        reason: "no allow rule matched",
        suggestedRule: {
          type: "domain",
          host: "api.weather.com",
          ports: [443],
        },
      },
    });
    expect(JSON.stringify(auditEvents[0])).not.toContain("evil.example");
  });

  test("calls resumeGraphWithAskReply with threadId, verb, processor, and laneKey on 200", async () => {
    resumeSpy.mockClear();

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/approval-reply",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${validToken}`,
      },
      payload: { verb: "room", threadId: "thread-abc" },
    });

    expect(res.statusCode).toBe(200);
    expect(resumeSpy).toHaveBeenCalledTimes(1);

    const call = resumeSpy.mock.calls[0]!;
    expect(call[0]).toBe("thread-abc");
    expect(call[1]).toBe("room");
    // processor is an object with process() and flush() methods
    expect(call[2]).toBeDefined();
    expect(typeof (call[2] as { process: unknown }).process).toBe("function");
    expect(typeof (call[2] as { flush: unknown }).flush).toBe("function");
    expect(call[3]).toBe("thread-abc");
  });

  test("does not resume a Strict checkpoint when client authorization metadata is absent", async () => {
    resumeSpy.mockClear();
    shadowBehavior = "strict";
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/approval-reply",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${validToken}`,
        },
        payload: { verb: "once", threadId: "thread-strict-no-crypto" },
      });

      expect(res.statusCode).toBe(200);
      await Bun.sleep(20);
      expect(resumeSpy).not.toHaveBeenCalled();
    } finally {
      shadowBehavior = "fallback";
    }
  });

  test("attributes a resumed multi-Agent reply to the paused graph Agent, not the envelope default", async () => {
    resumeSpy.mockClear();
    const collected: ServerEvent[] = [];
    const handler = (event: ServerEvent) => collected.push(event);
    eventBus.on(handler);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/approval-reply",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${validToken}`,
        },
        payload: { verb: "once", threadId: SAMPLE_APPROVAL_THREAD },
      });

      expect(res.statusCode).toBe(200);
      expect(resumeSpy).toHaveBeenCalledTimes(1);
      const processor = resumeSpy.mock.calls[0]![2] as {
        process(event: unknown): Promise<void>;
        flush(): void;
      };
      await processor.process({
        event: "on_chat_model_stream",
        data: { chunk: { content: "Nova live token" } },
      });
      processor.flush();

      const tokens = collected.find(
        (event) => event.type === "message.tokens",
      );
      expect(tokens).toMatchObject({
        type: "message.tokens",
        authorAgentId: SAMPLE_AGENT_ID,
      });
      expect(JSON.stringify(tokens)).not.toContain("stub-envelope-agent");
    } finally {
      eventBus.off(handler);
    }
  });

  test("runs browser-bound resumes inside fresh Runtime authority with policy-matched checkpoint storage", async () => {
    resumeSpy.mockClear();
    buildEnvelopeSpy.mockClear();
    let protectedContextObserved = false;
    const ordering: string[] = [];
    const protectedRepository = Object.freeze({ kind: "protected-repository" });
    const protectedAccessPort = Object.freeze({ kind: "protected-access" });
    const protectedProjectionPort = Object.freeze({ kind: "protected-projection" });
    resumeSpy.mockImplementationOnce(async () => {
      ordering.push("resume");
      protectedContextObserved =
        getCurrentLiveShadowTurnContext()?.session?.checkpoint !== undefined;
    });
    let reservedDevice: string | undefined;
    let protectedRuns = 0;
    const composition = {
      reserveSharedAgentRuntimeResume: async (input: Readonly<{
        authorizationDeviceId: string;
      }>) => {
        reservedDevice = input.authorizationDeviceId;
        return {
          status: "reserved" as const,
          invocationId: "resume:unit",
          executionId: "35000000-0000-4000-8000-000000000298",
          roomId: "room-unit",
          agentId: "agent-unit",
          invokingHumanId: OWNER_ACTOR_ID,
          sourceDeviceId: "source-device",
          authorizationDeviceId: input.authorizationDeviceId,
          clientActionSessionId: "browser-session",
          policyRevision: 1,
          deadlineAt: Date.now() + 30_000,
        };
      },
      planSharedAgentExecutionAuthorization: async () => ({
        status: "authorized" as const,
        executionId: "35000000-0000-4000-8000-000000000298",
        executionKind: "resume" as const,
        planBytes: new Uint8Array([1]),
        sessionReference: "runtime-session",
        authorizationDigest: new Uint8Array(32).fill(1),
        scope: {
          subjectHumanId: OWNER_ACTOR_ID,
          issuingDeviceId: "approving-device",
          recipientKind: "nautilo_foreground_runtime" as const,
          browserSessionId: "browser-session",
          topLevelRoomId: "room-unit",
          policyRevision: 1,
          hostAuthorizationRevision: 1,
          namespaceIds: ["namespace-unit"],
          grantDomainIds: ["domain-unit"],
          domainAuthoritySetDigest: new Uint8Array(32).fill(2),
        },
      }),
      awaitSharedAgentExecutionAuthorization: async () => null,
      runAgentTurn: async (input: Readonly<{
        work(session: never): Promise<unknown>;
      }>) => {
        protectedRuns++;
        return {
          status: "executed" as const,
          value: await input.work({
            checkpoint: {
              crypto: {},
              namespaceId: "namespace-unit",
              namespaceAccessRevision: 1,
              agentAuthorizationRevision: 1,
              authorizationSession: Object.freeze({}),
            },
            createForegroundMemoryRepository: async () => {
              ordering.push("repository");
              return protectedRepository;
            },
            createForegroundMemoryAccessPort: async () => {
              ordering.push("access");
              return protectedAccessPort;
            },
            createForegroundMemoryProjectionPort: async () => {
              ordering.push("projection");
              return protectedProjectionPort;
            },
          } as never),
        };
      },
    } as unknown as ProductionLiveShadowMessageComposition;
    installProductionLiveShadowMessageComposition(app, composition);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/approval-reply",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${validToken}`,
        },
        payload: {
          verb: "once",
          threadId: "thread-protected-resume",
          clientActionSessionId: "browser-session",
          authorizationDeviceId: "approving-device",
        },
      });
      expect(res.statusCode).toBe(200);
      await Bun.sleep(15);
      expect(reservedDevice).toBe("approving-device");
      expect(protectedRuns).toBe(1);
      expect(resumeSpy).toHaveBeenCalledTimes(1);
      expect(resumeSpy.mock.calls[0]?.[4]).toBeUndefined();
      expect(protectedContextObserved).toBeTrue();
      expect(buildEnvelopeSpy).toHaveBeenCalledWith(
        OWNER_ACTOR_ID,
        "thread-protected-resume",
        "stub-envelope-agent",
        RESUME_ROOM_ID,
      );
      expect(ordering).toEqual(["repository", "access", "projection", "resume"]);
      const memoryDeps = resumeSpy.mock.calls[0]?.[16] as Record<string, unknown>;
      expect(memoryDeps).toBeDefined();
      const canonicalEnvelope = canonicalEnvelopeFor(
        OWNER_ACTOR_ID,
        "stub-envelope-agent",
        RESUME_ROOM_ID,
      );
      const canonicalState = {
        taskRun: false,
        subagentRun: false,
        userId: OWNER_ID,
        memoryAccessEnvelope: canonicalEnvelope,
      };
      expect((memoryDeps["protectedMemoryRepositoryForState"] as (state: unknown) => unknown)(canonicalState))
        .toBe(protectedRepository);
      expect((memoryDeps["protectedMemoryAccessPortForState"] as (state: unknown) => unknown)(canonicalState))
        .toBe(protectedAccessPort);
      expect((memoryDeps["protectedMemoryProjectionPortForState"] as (state: unknown) => unknown)(canonicalState))
        .toBe(protectedProjectionPort);
      expect(() => (memoryDeps["protectedMemoryRepositoryForState"] as (state: unknown) => unknown)({
          ...canonicalState,
          memoryAccessEnvelope: {
            ...canonicalEnvelope,
            roomId: "incidental-request-room",
          },
        }))
        .toThrow("Foreground Memory invocation authority changed");

      resumeSpy.mockClear();
      protectedContextObserved = false;
      resumeSpy.mockImplementationOnce(async () => {
        protectedContextObserved =
          getCurrentLiveShadowTurnContext()?.session?.checkpoint !== undefined;
      });
      shadowBehavior = "strict";
      const strictRes = await app.inject({
        method: "POST",
        url: "/api/auth/approval-reply",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${validToken}`,
        },
        payload: {
          verb: "once",
          threadId: "thread-protected-resume-strict",
          clientActionSessionId: "browser-session",
          authorizationDeviceId: "approving-device",
        },
      });
      expect(strictRes.statusCode).toBe(200);
      await Bun.sleep(15);
      expect(protectedRuns).toBe(2);
      expect(resumeSpy).toHaveBeenCalledTimes(1);
      expect(resumeSpy.mock.calls[0]?.[4]).toBeDefined();
      expect(protectedContextObserved).toBeTrue();

      const sentinel = "FULL_RESUME_ROUTE_PRIVATE_SENTINEL";
      const warningSpy = spyOn(console, "error").mockImplementation(() => {});
      encryptionMode = "encrypted_only";
      resumeSpy.mockClear();
      resumeSpy.mockImplementationOnce(async () => {
        throw new Error(sentinel);
      });
      try {
        const fullRes = await app.inject({
          method: "POST",
          url: "/api/auth/approval-reply",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${validToken}`,
          },
          payload: {
            verb: "once",
            threadId: "thread-protected-resume-full-failure",
            clientActionSessionId: "browser-session",
            authorizationDeviceId: "approving-device",
          },
        });
        expect(fullRes.statusCode).toBe(200);
        await Bun.sleep(15);
        expect(resumeSpy).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(warningSpy.mock.calls)).not.toContain(sentinel);
        expect(JSON.stringify(warningSpy.mock.calls)).toContain("protected resume failed");
      } finally {
        warningSpy.mockRestore();
        encryptionMode = "shadow_encryption";
      }
    } finally {
      shadowBehavior = "fallback";
      encryptionMode = "shadow_encryption";
      uninstallProductionLiveShadowMessageComposition(app);
    }
  });

  test("passes the Full guard without protected-memory ports when no fresh custody exists", async () => {
    resumeSpy.mockClear();
    buildEnvelopeSpy.mockClear();
    encryptionMode = "encrypted_only";
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/approval-reply",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${validToken}`,
        },
        payload: { verb: "once", threadId: "thread-full-without-custody" },
      });

      expect(res.statusCode).toBe(200);
      await Bun.sleep(15);
      expect(resumeSpy).toHaveBeenCalledTimes(1);
      expect(buildEnvelopeSpy).not.toHaveBeenCalled();
      const memoryDeps = resumeSpy.mock.calls[0]?.[16] as Record<string, unknown>;
      expect((memoryDeps["fullEncryptionOnlyForState"] as () => boolean)()).toBeTrue();
      expect(memoryDeps["protectedMemoryRepositoryForState"]).toBeUndefined();
      expect(memoryDeps["protectedMemoryAccessPortForState"]).toBeUndefined();
      expect(memoryDeps["protectedMemoryProjectionPortForState"]).toBeUndefined();
    } finally {
      encryptionMode = "shadow_encryption";
    }
  });

  test("prove-and-resume forwards canonical protected-memory dependencies from its fresh session", async () => {
    approvalResumeSpy.mockClear();
    buildEnvelopeSpy.mockClear();
    const ordering: string[] = [];
    const protectedRepository = Object.freeze({ kind: "prove-protected-repository" });
    const protectedAccessPort = Object.freeze({ kind: "prove-protected-access" });
    const protectedProjectionPort = Object.freeze({ kind: "prove-protected-projection" });
    approvalResumeSpy.mockImplementationOnce(async () => {
      ordering.push("resume");
    });
    const composition = {
      reserveSharedAgentRuntimeResume: async () => ({
        status: "reserved" as const,
        invocationId: "resume:prove-unit",
        executionId: "35000000-0000-4000-8000-000000000297",
        roomId: RESUME_ROOM_ID,
        agentId: "stub-envelope-agent",
        invokingHumanId: OWNER_ACTOR_ID,
        sourceDeviceId: "source-device",
        authorizationDeviceId: "approving-device",
        clientActionSessionId: "browser-session",
        policyRevision: 1,
        deadlineAt: Date.now() + 30_000,
      }),
      planSharedAgentExecutionAuthorization: async () => ({
        status: "authorized" as const,
        executionId: "35000000-0000-4000-8000-000000000297",
        executionKind: "resume" as const,
        planBytes: new Uint8Array([1]),
        sessionReference: "runtime-session",
        authorizationDigest: new Uint8Array(32).fill(1),
        scope: {
          subjectHumanId: OWNER_ACTOR_ID,
          issuingDeviceId: "approving-device",
          recipientKind: "nautilo_foreground_runtime" as const,
          browserSessionId: "browser-session",
          topLevelRoomId: RESUME_ROOM_ID,
          policyRevision: 1,
          hostAuthorizationRevision: 1,
          namespaceIds: ["namespace-unit"],
          grantDomainIds: ["domain-unit"],
          domainAuthoritySetDigest: new Uint8Array(32).fill(2),
        },
      }),
      awaitSharedAgentExecutionAuthorization: async () => null,
      runAgentTurn: async (input: Readonly<{
        work(session: never): Promise<unknown>;
      }>) => ({
        status: "executed" as const,
        value: await input.work({
          checkpoint: {
            crypto: {},
            namespaceId: "namespace-unit",
            namespaceAccessRevision: 1,
            agentAuthorizationRevision: 1,
            authorizationSession: Object.freeze({}),
          },
          createForegroundMemoryRepository: async () => {
            ordering.push("repository");
            return protectedRepository;
          },
          createForegroundMemoryAccessPort: async () => {
            ordering.push("access");
            return protectedAccessPort;
          },
          createForegroundMemoryProjectionPort: async () => {
            ordering.push("projection");
            return protectedProjectionPort;
          },
        } as never),
      }),
    } as unknown as ProductionLiveShadowMessageComposition;
    installProductionLiveShadowMessageComposition(app, composition);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/prove-and-resume",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${validToken}`,
        },
        payload: {
          denied: true,
          threadId: "thread-prove-protected-resume",
          challengeId: "prove-checkpoint-exact",
          clientActionSessionId: "browser-session",
          authorizationDeviceId: "approving-device",
        },
      });

      expect(res.statusCode).toBe(200);
      await Bun.sleep(15);
      expect(approvalResumeSpy).toHaveBeenCalledTimes(1);
      expect(approvalResumeSpy.mock.calls[0]?.[8]).toBe("prove-checkpoint-exact");
      expect(buildEnvelopeSpy).toHaveBeenCalledWith(
        OWNER_ACTOR_ID,
        "thread-prove-protected-resume",
        "stub-envelope-agent",
        RESUME_ROOM_ID,
      );
      expect(ordering).toEqual(["repository", "access", "projection", "resume"]);
      const memoryDeps = approvalResumeSpy.mock.calls[0]?.[7] as Record<string, unknown>;
      const canonicalEnvelope = canonicalEnvelopeFor(
        OWNER_ACTOR_ID,
        "stub-envelope-agent",
        RESUME_ROOM_ID,
      );
      const canonicalState = {
        taskRun: false,
        subagentRun: false,
        userId: OWNER_ID,
        memoryAccessEnvelope: canonicalEnvelope,
      };
      expect((memoryDeps["protectedMemoryRepositoryForState"] as (state: unknown) => unknown)(canonicalState))
        .toBe(protectedRepository);
      expect((memoryDeps["protectedMemoryAccessPortForState"] as (state: unknown) => unknown)(canonicalState))
        .toBe(protectedAccessPort);
      expect((memoryDeps["protectedMemoryProjectionPortForState"] as (state: unknown) => unknown)(canonicalState))
        .toBe(protectedProjectionPort);
    } finally {
      uninstallProductionLiveShadowMessageComposition(app);
    }
  });

  test("separates chained prove prompts in one turn and forwards exact checkpoint identity", async () => {
    const coordinates: string[] = [];
    const executionId = "35000000-0000-4000-8000-000000000290";
    const composition = {
      reserveSharedAgentRuntimeResume: async (input: { resumeCoordinate: string }) => {
        coordinates.push(input.resumeCoordinate);
        return { status: "replayed", cancelRecovery: "unavailable" };
      },
      planSharedAgentExecutionAuthorization: async () => authorizedProtectedResumePlan(executionId),
      awaitSharedAgentExecutionAuthorization: async () => null,
    } as unknown as ProductionLiveShadowMessageComposition;
    installProductionLiveShadowMessageComposition(app, composition);
    try {
      for (const challengeId of ["first-checkpoint-interrupt", "second-checkpoint-interrupt"]) {
        const res = await app.inject({
          method: "POST", url: "/api/auth/prove-and-resume",
          headers: { Authorization: `Bearer ${validToken}` },
          payload: { denied: true, threadId: "same-turn-chained-prove", challengeId,
            clientActionSessionId: "browser-session", authorizationDeviceId: "approving-device" },
        });
        expect(res.statusCode).toBe(409);
      }
      expect(coordinates).toHaveLength(2);
      expect(coordinates[0]).not.toBe(coordinates[1]);
    } finally {
      uninstallProductionLiveShadowMessageComposition(app);
    }
  });

  test("approve and deny consume the same protected interrupt while authorization is pending", async () => {
    const verifyPin = spyOn(PinChallengeProvider.prototype, "verifyProof").mockResolvedValue(true);
    const coordinates: string[] = [];
    const claimed = new Set<string>();
    const executionId = "35000000-0000-4000-8000-000000000289";
    let release!: () => void;
    let entered!: () => void;
    const authorizationGate = new Promise<void>((resolve) => { release = resolve; });
    const authorizationEntered = new Promise<void>((resolve) => { entered = resolve; });
    const composition = {
      reserveSharedAgentRuntimeResume: async (input: { resumeCoordinate: string }) => {
        coordinates.push(input.resumeCoordinate);
        if (claimed.has(input.resumeCoordinate)) return { status: "replayed", cancelRecovery: "unavailable" };
        claimed.add(input.resumeCoordinate);
        return protectedResumeReservation(executionId);
      },
      planSharedAgentExecutionAuthorization: async () => {
        entered();
        await authorizationGate;
        return authorizedProtectedResumePlan(executionId);
      },
      awaitSharedAgentExecutionAuthorization: async () => null,
      runAgentTurn: async () => ({ status: "unavailable", reason: "test-stops-before-graph" }),
      recordSharedAgentExecutionUnavailable: async () => "recorded",
    } as unknown as ProductionLiveShadowMessageComposition;
    installProductionLiveShadowMessageComposition(app, composition);
    try {
      const common = { threadId: "prove-conflicting-decisions", challengeId: "exact-race-interrupt",
        clientActionSessionId: "browser-session", authorizationDeviceId: "approving-device" };
      const approving = app.inject({ method: "POST", url: "/api/auth/prove-and-resume",
        headers: { Authorization: `Bearer ${validToken}` }, payload: { ...common, pin: "000000" } });
      await authorizationEntered;
      const denying = await app.inject({ method: "POST", url: "/api/auth/prove-and-resume",
        headers: { Authorization: `Bearer ${validToken}` }, payload: { ...common, denied: true } });
      expect(denying.statusCode).toBe(409);
      expect(coordinates).toHaveLength(2);
      expect(coordinates[0]).toBe(coordinates[1]);
      release();
      expect((await approving).statusCode).toBe(200);
      await Bun.sleep(15);
    } finally {
      release();
      verifyPin.mockRestore();
      uninstallProductionLiveShadowMessageComposition(app);
    }
  });

  test("rejects a replayed protected prove-it response before authorization, graph, execution, or lifecycle work", async () => {
    approvalResumeSpy.mockClear();
    const plan = mock(async () => authorizedProtectedResumePlan(
      "35000000-0000-4000-8000-000000000291",
    ));
    const runAgentTurn = mock(async () => ({
      status: "unavailable" as const,
      reason: "authority_changed" as const,
    }));
    const collected: ServerEvent[] = [];
    const handler = (event: ServerEvent) => collected.push(event);
    eventBus.on(handler);
    const composition = {
      reserveSharedAgentRuntimeResume: async () => ({
        status: "replayed" as const,
        cancelRecovery: "unavailable" as const,
      }),
      planSharedAgentExecutionAuthorization: plan,
      awaitSharedAgentExecutionAuthorization: async () => null,
      runAgentTurn,
    } as unknown as ProductionLiveShadowMessageComposition;
    installProductionLiveShadowMessageComposition(app, composition);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/prove-and-resume",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${validToken}`,
        },
        payload: {
          denied: true,
          threadId: "thread-protected-prove-replayed",
          clientActionSessionId: "browser-session",
          authorizationDeviceId: "approving-device",
        },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json<{ error: string; code: string }>()).toEqual({
        error: "This response was already submitted. No new action was started.",
        code: "protected_resume_already_submitted",
      });
      await Bun.sleep(15);
      expect(plan).not.toHaveBeenCalled();
      expect(runAgentTurn).not.toHaveBeenCalled();
      expect(approvalResumeSpy).not.toHaveBeenCalled();
      expect(collected).not.toContainEqual(expect.objectContaining({
        type: "job.status",
        laneKey: "thread-protected-prove-replayed",
      }));
    } finally {
      eventBus.off(handler);
      uninstallProductionLiveShadowMessageComposition(app);
    }
  });

  test("admits denial recovery only after the exact protected ask is durably failed", async () => {
    resumeSpy.mockClear();
    const executionId = "35000000-0000-4000-8000-000000000292";
    const resumeCoordinates: string[] = [];
    const plan = mock(async () => authorizedProtectedResumePlan(executionId));
    const recordedUnavailable: Array<{ executionId: string; reason: string; now: number }> = [];
    let reservationCount = 0;
    const composition = {
      reserveSharedAgentRuntimeResume: async (input: Readonly<{
        resumeCoordinate: string;
      }>) => {
        reservationCount++;
        resumeCoordinates.push(input.resumeCoordinate);
        if (reservationCount <= 2) {
          return {
            status: "replayed" as const,
            cancelRecovery: "available" as const,
          };
        }
        return protectedResumeReservation(executionId);
      },
      planSharedAgentExecutionAuthorization: plan,
      awaitSharedAgentExecutionAuthorization: async () => null,
      runAgentTurn: async (input: Readonly<{
        work(session: never): Promise<unknown>;
      }>) => ({
        status: "executed" as const,
        value: await input.work({
          checkpoint: {
            crypto: {},
            namespaceId: "namespace-unit",
            namespaceAccessRevision: 1,
            agentAuthorizationRevision: 1,
            authorizationSession: Object.freeze({}),
          },
        } as never),
      }),
      recordSharedAgentExecutionUnavailable: async (input: {
        executionId: string;
        reason: string;
        now: number;
      }) => {
        recordedUnavailable.push(input);
        return "recorded" as const;
      },
    } as unknown as ProductionLiveShadowMessageComposition;
    installProductionLiveShadowMessageComposition(app, composition);
    try {
      const commonPayload = {
        approvalId: "approval-protected-replay-then-deny",
        threadId: "thread-protected-replay-then-deny",
        clientActionSessionId: "browser-session",
        authorizationDeviceId: "approving-device",
      };
      const replayed = await app.inject({
        method: "POST",
        url: "/api/auth/approval-reply",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${validToken}`,
        },
        payload: { ...commonPayload, verb: "once" },
      });

      expect(replayed.statusCode).toBe(409);
      expect(replayed.json<{ error: string; code: string }>()).toEqual({
        error: "This response was already submitted. No new action was started.",
        code: "protected_resume_already_submitted",
      });
      expect(resumeSpy).not.toHaveBeenCalled();
      expect(plan).not.toHaveBeenCalled();

      const denied = await app.inject({
        method: "POST",
        url: "/api/auth/approval-reply",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${validToken}`,
        },
        payload: { ...commonPayload, verb: "deny" },
      });

      expect(denied.statusCode).toBe(200);
      await Bun.sleep(25);
      expect(reservationCount).toBe(3);
      expect(resumeCoordinates).toHaveLength(3);
      expect(resumeCoordinates[0]).toBe(resumeCoordinates[1]);
      expect(resumeCoordinates[1]).not.toBe(resumeCoordinates[2]);
      expect(plan).toHaveBeenCalledTimes(1);
      expect(resumeSpy).toHaveBeenCalledTimes(1);
      expect(resumeSpy.mock.calls[0]?.[1]).toBe("deny");
      expect(recordedUnavailable).toEqual([]);
    } finally {
      uninstallProductionLiveShadowMessageComposition(app);
    }
  });

  test("does not replay protected resume work when the fresh session later reports unavailable", async () => {
    resumeSpy.mockClear();
    const executionId = "35000000-0000-4000-8000-000000000296";
    const privateFailure = "PRIVATE_UNAVAILABLE_REASON_SENTINEL";
    const recordedUnavailable: Array<{
      executionId: string;
      reason: string;
      now: number;
    }> = [];
    const composition = {
      reserveSharedAgentRuntimeResume: async () => protectedResumeReservation(executionId),
      planSharedAgentExecutionAuthorization: async () =>
        authorizedProtectedResumePlan(executionId),
      awaitSharedAgentExecutionAuthorization: async () => null,
      runAgentTurn: async (input: Readonly<{
        work(session: never): Promise<unknown>;
      }>) => {
        await input.work({
          checkpoint: {
            crypto: {},
            namespaceId: "namespace-unit",
            namespaceAccessRevision: 1,
            agentAuthorizationRevision: 1,
            authorizationSession: Object.freeze({}),
          },
        } as never);
        return { status: "unavailable" as const, reason: privateFailure };
      },
      recordSharedAgentExecutionUnavailable: async (input: {
        executionId: string;
        reason: string;
        now: number;
      }) => {
        recordedUnavailable.push(input);
        return "recorded" as const;
      },
    } as unknown as ProductionLiveShadowMessageComposition;
    installProductionLiveShadowMessageComposition(app, composition);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/approval-reply",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${validToken}`,
        },
        payload: {
          verb: "once",
          threadId: "thread-protected-no-replay",
          clientActionSessionId: "browser-session",
          authorizationDeviceId: "approving-device",
        },
      });

      expect(res.statusCode).toBe(200);
      await Bun.sleep(25);
      expect(resumeSpy).toHaveBeenCalledTimes(1);
      expect(recordedUnavailable).toHaveLength(1);
      expect(recordedUnavailable[0]).toMatchObject({
        executionId,
        reason: "protected_resume_failed",
      });
      expect(Number.isSafeInteger(recordedUnavailable[0]?.now)).toBeTrue();
      expect(JSON.stringify(recordedUnavailable[0])).not.toContain(privateFailure);
    } finally {
      uninstallProductionLiveShadowMessageComposition(app);
    }
  });

  test.each([
    ["expiry", new Error("protected_memory_approval_expired"), "This sharing preview expired before approval."],
    ["stale", Object.assign(new Error("private stale detail"), { code: "approval_request_stale" }), "That approval is no longer pending."],
  ] as const)("preserves safe %s when the custody wrapper hides callback errors", async (kind, error, expected) => {
    resumeSpy.mockClear();
    resumeSpy.mockImplementationOnce(async () => { throw error; });
    const collected: ServerEvent[] = [];
    const handler = (event: ServerEvent) => collected.push(event);
    eventBus.on(handler);
    const executionId = "35000000-0000-4000-8000-000000000292";
    const composition = {
      reserveSharedAgentRuntimeResume: async () => protectedResumeReservation(executionId),
      planSharedAgentExecutionAuthorization: async () => authorizedProtectedResumePlan(executionId),
      awaitSharedAgentExecutionAuthorization: async () => null,
      runAgentTurn: async (input: Readonly<{ work(session: never): Promise<unknown> }>) => {
        try { await input.work(null as never); } catch { /* Real custody boundary redacts exceptions. */ }
        return { status: "unavailable", reason: "session_unavailable" };
      },
      recordSharedAgentExecutionUnavailable: async () => "recorded",
    } as unknown as ProductionLiveShadowMessageComposition;
    installProductionLiveShadowMessageComposition(app, composition);
    try {
      const res = await app.inject({ method: "POST", url: "/api/auth/approval-reply",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${validToken}` },
        payload: { verb: "once", threadId: `thread-protected-safe-${kind}`,
          clientActionSessionId: "browser-session", authorizationDeviceId: "approving-device" },
      });
      expect(res.statusCode).toBe(200);
      await Bun.sleep(25);
      expect(resumeSpy).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(collected)).toContain(expected);
      expect(JSON.stringify(collected)).not.toContain(error.message);
    } finally {
      eventBus.off(handler);
      uninstallProductionLiveShadowMessageComposition(app);
    }
  });

  test("terminalizes a thrown protected resume without exposing its error or starting ordinary work", async () => {
    resumeSpy.mockClear();
    const executionId = "35000000-0000-4000-8000-000000000293";
    const privateFailure = "PRIVATE_PROTECTED_RESUME_THROW_SENTINEL";
    const recordedUnavailable: Array<{
      executionId: string;
      reason: string;
      now: number;
    }> = [];
    const composition = {
      reserveSharedAgentRuntimeResume: async () => protectedResumeReservation(executionId),
      planSharedAgentExecutionAuthorization: async () =>
        authorizedProtectedResumePlan(executionId),
      awaitSharedAgentExecutionAuthorization: async () => null,
      runAgentTurn: async () => {
        throw new Error(privateFailure);
      },
      recordSharedAgentExecutionUnavailable: async (input: {
        executionId: string;
        reason: string;
        now: number;
      }) => {
        recordedUnavailable.push(input);
        return "recorded" as const;
      },
    } as unknown as ProductionLiveShadowMessageComposition;
    installProductionLiveShadowMessageComposition(app, composition);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/approval-reply",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${validToken}`,
        },
        payload: {
          verb: "once",
          threadId: "thread-protected-throw-terminalized",
          clientActionSessionId: "browser-session",
          authorizationDeviceId: "approving-device",
        },
      });

      expect(res.statusCode).toBe(200);
      await Bun.sleep(25);
      expect(resumeSpy).not.toHaveBeenCalled();
      expect(recordedUnavailable).toHaveLength(1);
      expect(recordedUnavailable[0]).toMatchObject({
        executionId,
        reason: "protected_resume_failed",
      });
      expect(Number.isSafeInteger(recordedUnavailable[0]?.now)).toBeTrue();
      expect(JSON.stringify(recordedUnavailable[0])).not.toContain(privateFailure);
    } finally {
      uninstallProductionLiveShadowMessageComposition(app);
    }
  });

  test("dispatches an accepted connected-web Done through protected resume and reconciliation", async () => {
    connectedWebActionResumeSpy.mockClear();
    invokedAgentIds = [];
    let protectedRuns = 0;
    let reservedAgentId: string | undefined;
    const reconcileSpy = mock(() => {});
    const originalReconcile = jobManager.reconcileForkAndResumePendingTurns;
    jobManager.reconcileForkAndResumePendingTurns = reconcileSpy;
    const composition = {
      reserveSharedAgentRuntimeResume: async (input: Readonly<{ agentId: string }>) => {
        reservedAgentId = input.agentId;
        return ({
        status: "reserved" as const,
        invocationId: "resume:connected-web",
        executionId: "35000000-0000-4000-8000-000000000299",
        roomId: CONNECTED_WEB_ROOM_ID,
        agentId: "originating-agent",
        invokingHumanId: OWNER_ACTOR_ID,
        sourceDeviceId: "source-device",
        authorizationDeviceId: "approving-device",
        clientActionSessionId: "browser-session",
        policyRevision: 1,
        deadlineAt: Date.now() + 30_000,
        });
      },
      planSharedAgentExecutionAuthorization: async () => ({
        status: "authorized" as const,
        executionId: "35000000-0000-4000-8000-000000000299",
        executionKind: "resume" as const,
        planBytes: new Uint8Array([1]),
        sessionReference: "runtime-session",
        authorizationDigest: new Uint8Array(32).fill(1),
        scope: {
          subjectHumanId: OWNER_ACTOR_ID,
          issuingDeviceId: "approving-device",
          recipientKind: "nautilo_foreground_runtime" as const,
          browserSessionId: "browser-session",
          topLevelRoomId: CONNECTED_WEB_ROOM_ID,
          policyRevision: 1,
          hostAuthorizationRevision: 1,
          namespaceIds: ["namespace-unit"],
          grantDomainIds: ["domain-unit"],
          domainAuthoritySetDigest: new Uint8Array(32).fill(2),
        },
      }),
      awaitSharedAgentExecutionAuthorization: async () => null,
      runAgentTurn: async (input: Readonly<{ work(session: never): Promise<unknown> }>) => {
        protectedRuns++;
        return {
          status: "executed" as const,
          value: await input.work({
            checkpoint: {
              crypto: {},
              namespaceId: "namespace-unit",
              namespaceAccessRevision: 1,
              agentAuthorizationRevision: 1,
              authorizationSession: Object.freeze({}),
            },
          } as never),
        };
      },
    } as unknown as ProductionLiveShadowMessageComposition;
    installProductionLiveShadowMessageComposition(app, composition);
    shadowBehavior = "strict";
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/connected-web-action-reply",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${validToken}` },
        payload: {
          threadId: CONNECTED_WEB_THREAD_ID,
          laneKey: CONNECTED_WEB_LANE_KEY,
          toolCallId: CONNECTED_WEB_ATTENTION.toolCallId,
          decision: "done",
          clientActionSessionId: "browser-session",
          authorizationDeviceId: "approving-device",
        },
      });
      expect(res.statusCode).toBe(200);
      await Bun.sleep(15);
      expect(protectedRuns).toBe(1);
      expect(reservedAgentId).toBe("originating-agent");
      expect(invokedAgentIds).toContain("originating-agent");
      expect(connectedWebActionResumeSpy).toHaveBeenCalledTimes(1);
      const call = connectedWebActionResumeSpy.mock.calls[0]!;
      expect(call[0]).toBe(CONNECTED_WEB_THREAD_ID);
      expect(call[1]).toEqual({ toolCallId: CONNECTED_WEB_ATTENTION.toolCallId, decision: "done" });
      expect(call[2]).toEqual(CONNECTED_WEB_ATTENTION.intervention);
      expect(call[3]).toBe(OWNER_ID);
      expect(call[5]).toBe(CONNECTED_WEB_LANE_KEY);
      expect(call[6]).toBeDefined();
      expect(typeof call[8]).toBe("function");
      expect(reconcileSpy).toHaveBeenCalledWith(CONNECTED_WEB_THREAD_ID);
    } finally {
      shadowBehavior = "fallback";
      jobManager.reconcileForkAndResumePendingTurns = originalReconcile;
      uninstallProductionLiveShadowMessageComposition(app);
    }
  });

  test("rejects a connected-web reply when its lane is not the checkpoint's originating Genie", async () => {
    connectedWebActionResumeSpy.mockClear();
    const prior = connectedWebCheckpointBinding;
    connectedWebCheckpointBinding = { agentId: "originating-agent", laneKey: `room:${CONNECTED_WEB_ROOM_ID}:user:another-human:bot:originating-agent` };
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/connected-web-action-reply",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${validToken}` },
        payload: {
          threadId: CONNECTED_WEB_THREAD_ID,
          laneKey: CONNECTED_WEB_LANE_KEY,
          toolCallId: CONNECTED_WEB_ATTENTION.toolCallId,
          decision: "cancel",
          clientActionSessionId: "browser-session",
          authorizationDeviceId: "approving-device",
        },
      });
      expect(res.statusCode).toBe(409);
      expect(connectedWebActionResumeSpy).not.toHaveBeenCalled();
    } finally {
      connectedWebCheckpointBinding = prior;
    }
  });

  test("admits only one in-process Done/Cancel decision for an exact parked action", async () => {
    connectedWebActionResumeSpy.mockClear();
    let reserved = false;
    const composition = {
      reserveSharedAgentRuntimeResume: async () => {
        if (reserved) return {
          status: "replayed" as const,
          cancelRecovery: "unavailable" as const,
        };
        reserved = true;
        return {
        status: "reserved" as const,
        invocationId: "resume:connected-web-race",
        executionId: "35000000-0000-4000-8000-000000000297",
        roomId: CONNECTED_WEB_ROOM_ID,
        agentId: "originating-agent",
        invokingHumanId: OWNER_ACTOR_ID,
        sourceDeviceId: "source-device",
        authorizationDeviceId: "approving-device",
        clientActionSessionId: "browser-session",
        policyRevision: 1,
        deadlineAt: Date.now() + 30_000,
      };
      },
      planSharedAgentExecutionAuthorization: async () => ({
        status: "authorized" as const,
        executionId: "35000000-0000-4000-8000-000000000297",
        executionKind: "resume" as const,
        planBytes: new Uint8Array([1]),
        sessionReference: "runtime-session",
        authorizationDigest: new Uint8Array(32).fill(1),
        scope: {
          subjectHumanId: OWNER_ACTOR_ID,
          issuingDeviceId: "approving-device",
          recipientKind: "nautilo_foreground_runtime" as const,
          browserSessionId: "browser-session",
          topLevelRoomId: CONNECTED_WEB_ROOM_ID,
          policyRevision: 1,
          hostAuthorizationRevision: 1,
          namespaceIds: ["namespace-unit"],
          grantDomainIds: ["domain-unit"],
          domainAuthoritySetDigest: new Uint8Array(32).fill(2),
        },
      }),
      awaitSharedAgentExecutionAuthorization: async () => null,
      runAgentTurn: async (input: Readonly<{ work(session: never): Promise<unknown> }>) => ({ status: "executed" as const, value: await input.work(null as never) }),
    } as unknown as ProductionLiveShadowMessageComposition;
    installProductionLiveShadowMessageComposition(app, composition);
    try {
      const common = {
        threadId: CONNECTED_WEB_THREAD_ID,
        laneKey: CONNECTED_WEB_LANE_KEY,
        toolCallId: CONNECTED_WEB_RACE_ATTENTION.toolCallId,
        clientActionSessionId: "browser-session",
        authorizationDeviceId: "approving-device",
      };
      const responses = await Promise.all(["done", "cancel"].map((decision) => app.inject({
        method: "POST",
        url: "/api/auth/connected-web-action-reply",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${validToken}` },
        payload: { ...common, decision },
      })));
      expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
      await Bun.sleep(15);
      expect(connectedWebActionResumeSpy).toHaveBeenCalledTimes(1);
    } finally {
      uninstallProductionLiveShadowMessageComposition(app);
    }
  });

  test("cancels the exact parked action when an accepted resume fails before consuming it", async () => {
    connectedWebActionResumeSpy.mockImplementationOnce(async () => { throw new Error("resume failed"); });
    const seen: ServerEvent[] = [];
    const handler = (event: ServerEvent) => { seen.push(event); };
    eventBus.on(handler);
    const composition = {
      reserveSharedAgentRuntimeResume: async () => ({
        status: "reserved" as const,
        invocationId: "resume:connected-web-failed",
        executionId: "35000000-0000-4000-8000-000000000296",
        roomId: CONNECTED_WEB_ROOM_ID,
        agentId: "originating-agent",
        invokingHumanId: OWNER_ACTOR_ID,
        sourceDeviceId: "source-device",
        authorizationDeviceId: "approving-device",
        clientActionSessionId: "browser-session",
        policyRevision: 1,
        deadlineAt: Date.now() + 30_000,
      }),
      planSharedAgentExecutionAuthorization: async () => ({
        status: "authorized" as const,
        executionId: "35000000-0000-4000-8000-000000000296",
        executionKind: "resume" as const,
        planBytes: new Uint8Array([1]),
        sessionReference: "runtime-session",
        authorizationDigest: new Uint8Array(32).fill(1),
        scope: {
          subjectHumanId: OWNER_ACTOR_ID,
          issuingDeviceId: "approving-device",
          recipientKind: "nautilo_foreground_runtime" as const,
          browserSessionId: "browser-session",
          topLevelRoomId: CONNECTED_WEB_ROOM_ID,
          policyRevision: 1,
          hostAuthorizationRevision: 1,
          namespaceIds: ["namespace-unit"],
          grantDomainIds: ["domain-unit"],
          domainAuthoritySetDigest: new Uint8Array(32).fill(2),
        },
      }),
      awaitSharedAgentExecutionAuthorization: async () => null,
      runAgentTurn: async (input: Readonly<{ work(session: never): Promise<unknown> }>) => ({ status: "executed" as const, value: await input.work(null as never) }),
    } as unknown as ProductionLiveShadowMessageComposition;
    installProductionLiveShadowMessageComposition(app, composition);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/connected-web-action-reply",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${validToken}` },
        payload: {
          threadId: CONNECTED_WEB_THREAD_ID,
          laneKey: CONNECTED_WEB_LANE_KEY,
          toolCallId: CONNECTED_WEB_FAILED_ATTENTION.toolCallId,
          decision: "done",
          clientActionSessionId: "browser-session",
          authorizationDeviceId: "approving-device",
        },
      });
      expect(res.statusCode).toBe(200);
      await Bun.sleep(30);
      expect(connectedWebActionResumeSpy.mock.calls.slice(-2).map((call) => call[1])).toEqual([
        { toolCallId: CONNECTED_WEB_FAILED_ATTENTION.toolCallId, decision: "done" },
        { toolCallId: CONNECTED_WEB_FAILED_ATTENTION.toolCallId, decision: "cancel" },
      ]);
      expect(seen).not.toContainEqual({
        type: "connected_web.action_resume_failed",
        threadId: CONNECTED_WEB_THREAD_ID,
        laneKey: CONNECTED_WEB_LANE_KEY,
        toolCallId: CONNECTED_WEB_FAILED_ATTENTION.toolCallId,
        userId: OWNER_ID,
      });
    } finally {
      eventBus.off(handler);
      uninstallProductionLiveShadowMessageComposition(app);
    }
  });

  test("publishes exact private failure truth when both resume and safe cancellation fail", async () => {
    connectedWebActionResumeSpy.mockImplementation(async () => { throw new Error("resume failed"); });
    const seen: ServerEvent[] = [];
    const handler = (event: ServerEvent) => { seen.push(event); };
    eventBus.on(handler);
    let reservationCall = 0;
    let executionState: "running" | "fallback" = "running";
    let currentExecutionId = "35000000-0000-4000-8000-000000000295";
    const recordedUnavailable: Array<{ executionId: string; reason: string; now: number }> = [];
    const composition = {
      reserveSharedAgentRuntimeResume: async () => {
        reservationCall++;
        if (reservationCall === 2 || reservationCall === 3) return {
          status: "replayed" as const,
          cancelRecovery: executionState === "fallback" ? "available" as const : "unavailable" as const,
        };
        currentExecutionId = reservationCall === 1
          ? "35000000-0000-4000-8000-000000000295"
          : "35000000-0000-4000-8000-000000000294";
        return {
        status: "reserved" as const,
        invocationId: "resume:connected-web-double-failed",
        executionId: currentExecutionId,
        roomId: CONNECTED_WEB_ROOM_ID,
        agentId: "originating-agent",
        invokingHumanId: OWNER_ACTOR_ID,
        sourceDeviceId: "source-device",
        authorizationDeviceId: "approving-device",
        clientActionSessionId: "browser-session",
        policyRevision: 1,
        deadlineAt: Date.now() + 30_000,
      };
      },
      planSharedAgentExecutionAuthorization: async () => ({
        status: "authorized" as const,
        executionId: currentExecutionId,
        executionKind: "resume" as const,
        planBytes: new Uint8Array([1]),
        sessionReference: "runtime-session",
        authorizationDigest: new Uint8Array(32).fill(1),
        scope: {
          subjectHumanId: OWNER_ACTOR_ID,
          issuingDeviceId: "approving-device",
          recipientKind: "nautilo_foreground_runtime" as const,
          browserSessionId: "browser-session",
          topLevelRoomId: CONNECTED_WEB_ROOM_ID,
          policyRevision: 1,
          hostAuthorizationRevision: 1,
          namespaceIds: ["namespace-unit"],
          grantDomainIds: ["domain-unit"],
          domainAuthoritySetDigest: new Uint8Array(32).fill(2),
        },
      }),
      awaitSharedAgentExecutionAuthorization: async () => null,
      runAgentTurn: async (input: Readonly<{ work(session: never): Promise<unknown> }>) => ({ status: "executed" as const, value: await input.work(null as never) }),
      recordSharedAgentExecutionUnavailable: async (input: { executionId: string; reason: string; now: number }) => {
        recordedUnavailable.push(input);
        executionState = "fallback";
        return "recorded" as const;
      },
    } as unknown as ProductionLiveShadowMessageComposition;
    installProductionLiveShadowMessageComposition(app, composition);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/connected-web-action-reply",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${validToken}` },
        payload: {
          threadId: CONNECTED_WEB_THREAD_ID,
          laneKey: CONNECTED_WEB_LANE_KEY,
          toolCallId: CONNECTED_WEB_DOUBLE_FAILED_ATTENTION.toolCallId,
          decision: "done",
          clientActionSessionId: "browser-session",
          authorizationDeviceId: "approving-device",
        },
      });
      expect(res.statusCode).toBe(200);
      await Bun.sleep(30);
      expect(seen).toContainEqual({
        type: "connected_web.action_resume_failed",
        threadId: CONNECTED_WEB_THREAD_ID,
        laneKey: CONNECTED_WEB_LANE_KEY,
        toolCallId: CONNECTED_WEB_DOUBLE_FAILED_ATTENTION.toolCallId,
        userId: OWNER_ID,
        cancelRecovery: "available",
      });
      expect(recordedUnavailable).toHaveLength(1);
      expect(recordedUnavailable[0]).toMatchObject({
        executionId: "35000000-0000-4000-8000-000000000295",
        reason: "connected_web_action_resume_failed",
      });
      expect(typeof recordedUnavailable[0]?.now).toBe("number");
      connectedWebActionResumeSpy.mockImplementation(async () => {});
      const recovered = await app.inject({
        method: "POST",
        url: "/api/auth/connected-web-action-reply",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${validToken}` },
        payload: {
          threadId: CONNECTED_WEB_THREAD_ID,
          laneKey: CONNECTED_WEB_LANE_KEY,
          toolCallId: CONNECTED_WEB_DOUBLE_FAILED_ATTENTION.toolCallId,
          decision: "cancel",
          clientActionSessionId: "browser-session",
          authorizationDeviceId: "approving-device",
        },
      });
      expect(recovered.statusCode).toBe(200);
      await Bun.sleep(20);
      expect(connectedWebActionResumeSpy.mock.calls.at(-1)?.[1]).toEqual({
        toolCallId: CONNECTED_WEB_DOUBLE_FAILED_ATTENTION.toolCallId,
        decision: "cancel",
      });
      expect(reservationCall).toBe(4);
    } finally {
      connectedWebActionResumeSpy.mockImplementation(async () => {});
      eventBus.off(handler);
      uninstallProductionLiveShadowMessageComposition(app);
    }
  });

  test("forwards the mandatory local-MCP approval id and digest as one exact resume binding", async () => {
    resumeSpy.mockClear();
    const approvalId = "local-mcp-install:thread-local:lane-local:call-local";
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/approval-reply",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${validToken}`,
      },
      payload: {
        verb: "once",
        threadId: "thread-local",
        laneKey: "lane-local",
        approvalId,
        localMcpInstallDigest: "digest-local",
      },
    });
    expect(res.statusCode).toBe(200);
    const call = resumeSpy.mock.calls[0]!;
    expect(call[6]).toBe(approvalId);
    expect(call[7]).toBe("digest-local");
    expect(call[8]).toBe("lane-local");
  });

  test("rejects a local-MCP reply without its digest or with a standing verb", async () => {
    const approvalId = "local-mcp-install:thread-local:lane-local:call-local";
    for (const payload of [
      { verb: "once", threadId: "thread-local", approvalId },
      { verb: "always", threadId: "thread-local", approvalId, localMcpInstallDigest: "digest-local" },
    ]) {
      resumeSpy.mockClear();
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/approval-reply",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${validToken}`,
        },
        payload,
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: "approval_stale" });
      expect(resumeSpy).not.toHaveBeenCalled();
    }
  });

  test("a terminal local-MCP approval reply cannot launch the install a second time", async () => {
    resumeSpy.mockClear();
    const payload = {
      verb: "once",
      threadId: "thread-terminal-local",
      laneKey: "lane-terminal-local",
      approvalId: "local-mcp-install:turn-terminal:lane-terminal-local:call-terminal",
      localMcpInstallDigest: "digest-terminal-local",
    };
    const first = await app.inject({
      method: "POST",
      url: "/api/auth/approval-reply",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${validToken}`,
      },
      payload,
    });
    expect(first.statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(resumeSpy).toHaveBeenCalledTimes(1);

    const replay = await app.inject({
      method: "POST",
      url: "/api/auth/approval-reply",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${validToken}`,
      },
      payload,
    });
    // Existing approval lifecycle treats an identical terminal receipt as an
    // idempotent reply; it must not resume the graph or launch again.
    expect(replay.statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(resumeSpy).toHaveBeenCalledTimes(1);
  });

  test("each of the four verbs is forwarded verbatim to the resume call", async () => {
    for (const verb of ["once", "room", "always", "deny"] as const) {
      resumeSpy.mockClear();

      const res = await app.inject({
        method: "POST",
        url: "/api/auth/approval-reply",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${validToken}`,
        },
        payload: { verb, threadId: `thread-${verb}` },
      });

      expect(res.statusCode).toBe(200);
      expect(resumeSpy).toHaveBeenCalledTimes(1);
      expect(resumeSpy.mock.calls[0]![1]).toBe(verb);
    }
  });

  test("fire-and-forget: resume rejection does NOT affect the 200 response", async () => {
    // Swap the spy to reject so we exercise the catch() in the route.
    resumeSpy.mockImplementationOnce(() =>
      Promise.reject(new Error("synthetic resume failure")),
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/approval-reply",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${validToken}`,
      },
      payload: { verb: "once", threadId: "thread-will-fail" },
    });

    // Route returns 200 immediately; the rejection is logged, not bubbled.
    // This matches the sibling /api/auth/prove-and-resume behavior.
    expect(res.statusCode).toBe(200);
    expect(resumeSpy).toHaveBeenCalled();

    // Flush the rejected promise so it doesn't trigger unhandledRejection
    // during test teardown.
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  test("processor has expected contract (process + flush callable)", async () => {
    resumeSpy.mockClear();

    await app.inject({
      method: "POST",
      url: "/api/auth/approval-reply",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${validToken}`,
      },
      payload: { verb: "once", threadId: "thread-proc" },
    });

    const processor = resumeSpy.mock.calls[0]![2] as {
      process(ev: unknown): void;
      flush(): void;
    };

    // process(noop-event) should not throw — exercises the processor pipeline.
    expect(() => processor.process({})).not.toThrow();
    expect(() => processor.flush()).not.toThrow();
  });

  // D353 follow-up — regression: an approval-resumed turn MUST emit a
  // terminal `job.status` so the workbench clears `isRunning` / Stop.
  // Without the `runResumeJobLifecycle` wrapper in the route, the resumed
  // graph stream runs outside any Job and no terminal event fires —
  // leaving the Stop button stale after the final assistant message.
  test("emits terminal job.status:completed after the resume settles (D353 stale-Stop fix)", async () => {
    resumeSpy.mockClear();
    const collected: ServerEvent[] = [];
    const handler = (ev: ServerEvent) => collected.push(ev);
    eventBus.on(handler);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/approval-reply",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${validToken}`,
        },
        payload: { verb: "once", threadId: "thread-resume-lifecycle" },
      });
      expect(res.statusCode).toBe(200);

      // The resume spy resolves synchronously; let the
      // runResumeJobLifecycle `.then` chain run to completion before
      // asserting.
      await new Promise((resolve) => setTimeout(resolve, 20));

      const jobStatusEvents = collected.filter(
        (ev) => ev.type === "job.status",
      );
      // The wrapper emits dispatched → running → completed (or failed).
      const terminal = jobStatusEvents.filter(
        (ev) =>
          (ev as { status: string }).status === "completed" ||
          (ev as { status: string }).status === "failed" ||
          (ev as { status: string }).status === "cancelled" ||
          (ev as { status: string }).status === "timed_out",
      );
      expect(terminal.length).toBeGreaterThanOrEqual(1);
      const last = terminal[terminal.length - 1] as {
        status: string;
        laneKey?: string;
        turnId?: string;
        authorAgentId?: string;
      };
      expect(last.status).toBe("completed");
      // laneKey carries the room route so ws-event-room.ts can clear
      // the active room's `liveJobIdsRef` even on a jobIdToRoomId miss.
      expect(last.laneKey).toBe("thread-resume-lifecycle");
      expect(last.turnId).toBe("test-turn-id");
      expect(last.authorAgentId).toBe("stub-envelope-agent");
    } finally {
      eventBus.off(handler);
    }
  });

  test("emits terminal job.status:failed when the resume rejects (D353 stale-Stop fix)", async () => {
    resumeSpy.mockClear();
    resumeSpy.mockImplementationOnce(() =>
      Promise.reject(new Error("synthetic resume failure")),
    );
    const collected: ServerEvent[] = [];
    const handler = (ev: ServerEvent) => collected.push(ev);
    eventBus.on(handler);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/approval-reply",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${validToken}`,
        },
        payload: { verb: "once", threadId: "thread-resume-fail" },
      });
      expect(res.statusCode).toBe(200);

      // Drain the rejected resume promise + the failed-event emit.
      await new Promise((resolve) => setTimeout(resolve, 20));

      const terminal = collected.filter(
        (ev) =>
          ev.type === "job.status" &&
          ((ev as { status: string }).status === "failed" ||
            (ev as { status: string }).status === "completed" ||
            (ev as { status: string }).status === "cancelled"),
      );
      expect(terminal.length).toBeGreaterThanOrEqual(1);
      const last = terminal[terminal.length - 1] as {
        status: string;
        laneKey?: string;
        turnId?: string;
        authorAgentId?: string;
      };
      expect(last.status).toBe("failed");
      expect(last.laneKey).toBe("thread-resume-fail");
      expect(last.turnId).toBe("test-turn-id");
      expect(last.authorAgentId).toBe("stub-envelope-agent");
    } finally {
      eventBus.off(handler);
    }
  });
});

describe("POST /api/auth/host-choice-reply — exact paired host resume", () => {
  test("requires all opaque resume coordinates", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/host-choice-reply",
      headers: { Authorization: `Bearer ${validToken}` },
      payload: { choiceId: "choice-1" },
    });
    expect(response.statusCode).toBe(400);
  });

  test("resumes the same foreground graph with the opaque choice", async () => {
    hostChoiceResumeSpy.mockClear();
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/host-choice-reply",
      headers: { Authorization: `Bearer ${validToken}` },
      payload: {
        choiceId: "choice-1",
        selector: "selector-b",
        threadId: "thread-host-choice",
        laneKey: "room:one",
      },
    });
    expect(response.statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(hostChoiceResumeSpy).toHaveBeenCalledTimes(1);
    expect(hostChoiceResumeSpy.mock.calls[0]?.[0]).toBe("thread-host-choice");
    expect(hostChoiceResumeSpy.mock.calls[0]?.[1]).toEqual({
      choiceId: "choice-1",
      selector: "selector-b",
    });
    expect(hostChoiceResumeSpy.mock.calls[0]?.[3]).toBe("room:one");

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/auth/host-choice-reply",
      headers: { Authorization: `Bearer ${validToken}` },
      payload: {
        choiceId: "choice-1",
        selector: "selector-b",
        threadId: "thread-host-choice",
        laneKey: "room:one",
      },
    });
    expect(duplicate.statusCode).toBe(409);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(hostChoiceResumeSpy).toHaveBeenCalledTimes(1);
  });
});
