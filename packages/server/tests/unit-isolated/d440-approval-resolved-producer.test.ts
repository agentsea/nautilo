import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

const unexpectedDatabaseAccess = mock(() => {
  throw new Error("Approval lifecycle unit tests must not access a database");
});
mock.module("../../src/lib/server-direct-db", () => ({
  getServerDirectDb: unexpectedDatabaseAccess,
}));

type ResumeFn = (
  threadId: string,
  verb: string,
  processor: unknown,
  laneKey: string,
) => Promise<void>;

const resumeSpy = mock<ResumeFn>(async () => {});
const taskResumeSpy = mock<(...args: unknown[]) => Promise<{
  reparked: boolean;
  staleReply?: true;
}>>(
  async () => ({ reparked: false }),
);

const realAgent = await import("@nautilo/agent");
mock.module("@nautilo/agent", () => ({
  ...realAgent,
  resumeGraphWithAskReply: resumeSpy,
  resumeGraphWithApproval: mock(async () => {}),
  resumeGraphWithIdentity: mock(async () => {}),
  readTurnIdForThread: mock(async () => "d440-turn"),
  // Legacy approval resumes have no active D476 projection binding.
  readProjectionResumeBindingForThread: mock(async () => ({ kind: "none" as const })),
}));

const realRuntime = await import("@nautilo/runtime");
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
      agentId: "d440-agent",
      targetChat: "orphan",
      targetRoomId: null,
      scheduleKind: "once",
    },
    run: {
      id: "d440-task-run",
      graphThreadId: args.threadId,
    },
  })),
  runTaskApprovalResume: taskResumeSpy,
}));

import Fastify, { type FastifyInstance } from "fastify";
import type { WebSocket as WsWebSocket } from "ws";
import { PinChallengeProvider } from "@nautilo/trust";
import type { ServerEvent } from "@nautilo/types";
import { eventBus } from "@nautilo/runtime";
import { authRoutes } from "../../src/routes/auth";
import {
  createApprovalResolutionCoordinator,
  type ApprovalResolutionContext,
} from "../../src/routes/approval-resolved";
import {
  addClient,
  broadcast,
} from "../../src/realtime/ws-publisher";
import { SessionStore } from "../helpers/test-session-store";
import { installLocalAuthPreHandlerStub } from "../unit/helpers/auth-preHandler-stub";

const OWNER_ID = "d440-owner";
const OWNER_ACTOR_ID = "d440-owner-actor";

let app: FastifyInstance;
let token: string;

beforeAll(async () => {
  const sessions = new SessionStore(undefined, { persistPath: null });
  app = Fastify({ logger: false });
  installLocalAuthPreHandlerStub(app, sessions);
  authRoutes(app, {
    pinProvider: new PinChallengeProvider({ persistPath: null }),
    ownerActorId: OWNER_ACTOR_ID,
    ownerId: OWNER_ID,
    resumeThreadMembershipForUser: async () => true,
    assertCanInvokeAgent: async () => {},
    // D440 exercises approval lifecycle ordering in the ordinary/Fallback
    // path, not the durable Strict-policy decision itself.
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
  await app.ready();
  token = sessions.createSession(OWNER_ACTOR_ID, OWNER_ID, OWNER_ID).token;
});

beforeEach(() => {
  resumeSpy.mockClear();
  taskResumeSpy.mockClear();
});

afterAll(async () => {
  await app.close();
  expect(unexpectedDatabaseAccess).not.toHaveBeenCalled();
  mock.restore();
});

function approvalEvents(events: readonly ServerEvent[]) {
  return events.filter(
    (event): event is Extract<ServerEvent, { type: "approval.resolved" }> =>
      event.type === "approval.resolved",
  );
}

async function waitFor(
  predicate: () => boolean,
): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function postApproval(payload: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: "/api/auth/approval-reply",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    payload,
  });
}

describe("D440 approval.resolved coordinator", () => {
  const base: ApprovalResolutionContext = {
    approvalId: "coordinator-approval",
    threadId: "room:coordinator",
    laneKey: "room:coordinator",
    userId: OWNER_ID,
    verb: "once",
  };

  test("emits once after complete and suppresses duplicate retries/completions", () => {
    const events: ServerEvent[] = [];
    const coordinator = createApprovalResolutionCoordinator((event) =>
      events.push(event),
    );
    const first = coordinator.begin(base);
    expect(first.kind).toBe("started");
    if (first.kind !== "started") throw new Error("expected started");

    expect(events).toHaveLength(0);
    const emitted = coordinator.complete(base, first.token);
    expect(emitted).toMatchObject({
      type: "approval.resolved",
      approvalId: base.approvalId,
      threadId: base.threadId,
      laneKey: base.laneKey,
      userId: OWNER_ID,
      resolution: "approved",
      verb: "once",
    });
    expect(events).toHaveLength(1);
    expect(coordinator.complete(base, first.token)).toBeNull();
    expect(coordinator.begin(base)).toEqual({ kind: "duplicate" });
    expect(events).toHaveLength(1);
  });

  test("rejects a conflicting decision for the same requester/approval id", () => {
    const coordinator = createApprovalResolutionCoordinator(() => {});
    expect(coordinator.begin(base).kind).toBe("started");
    expect(coordinator.begin({ ...base, verb: "deny" })).toEqual({
      kind: "conflict",
    });
  });

  test("failed canonical resume releases the reservation for retry", () => {
    const coordinator = createApprovalResolutionCoordinator(() => {});
    const first = coordinator.begin(base);
    if (first.kind !== "started") throw new Error("expected started");
    coordinator.fail(base, first.token);
    expect(coordinator.begin(base).kind).toBe("started");
  });

  test("maps deny and preserves task provenance", () => {
    const events: ServerEvent[] = [];
    const coordinator = createApprovalResolutionCoordinator((event) =>
      events.push(event),
    );
    const taskContext: ApprovalResolutionContext = {
      ...base,
      approvalId: "task-denial",
      laneKey: "task:d440-task",
      verb: "deny",
      taskId: "d440-task",
      taskRunId: "d440-task-run",
      origin: "task",
    };
    const attempt = coordinator.begin(taskContext);
    if (attempt.kind !== "started") throw new Error("expected started");
    coordinator.complete(taskContext, attempt.token);
    expect(events[0]).toMatchObject({
      type: "approval.resolved",
      resolution: "denied",
      taskId: "d440-task",
      taskRunId: "d440-task-run",
      origin: "task",
    });
  });
});

describe("D440 approval.resolved HTTP producers", () => {
  test("main-thread route emits only after canonical resume settles", async () => {
    let releaseResume!: () => void;
    resumeSpy.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseResume = resolve;
        }),
    );
    const collected: ServerEvent[] = [];
    const handler = (event: ServerEvent) => collected.push(event);
    eventBus.on(handler);
    try {
      const response = await postApproval({
        verb: "once",
        approvalId: "main-after-resume",
        threadId: "room:main-after-resume",
        laneKey: "room:main-after-resume",
      });
      expect(response.statusCode).toBe(200);
      expect(approvalEvents(collected)).toHaveLength(0);

      await waitFor(() => typeof releaseResume === "function");
      releaseResume();
      await waitFor(() => approvalEvents(collected).length === 1);
      const resolved = approvalEvents(collected);
      expect(resolved).toHaveLength(1);
      expect(resolved[0]).toMatchObject({
        approvalId: "main-after-resume",
        userId: OWNER_ID,
        resolution: "approved",
        verb: "once",
      });
    } finally {
      eventBus.off(handler);
    }
  });

  test("same-decision HTTP retry neither resumes nor emits twice", async () => {
    const collected: ServerEvent[] = [];
    const handler = (event: ServerEvent) => collected.push(event);
    eventBus.on(handler);
    try {
      const payload = {
        verb: "room",
        approvalId: "main-idempotent",
        threadId: "room:main-idempotent",
        laneKey: "room:main-idempotent",
      };
      expect((await postApproval(payload)).statusCode).toBe(200);
      await waitFor(() => approvalEvents(collected).length === 1);
      expect((await postApproval(payload)).statusCode).toBe(200);

      expect(resumeSpy).toHaveBeenCalledTimes(1);
      expect(approvalEvents(collected)).toHaveLength(1);
    } finally {
      eventBus.off(handler);
    }
  });

  test("different-decision HTTP retry is rejected and does not resume twice", async () => {
    const basePayload = {
      approvalId: "main-conflict",
      threadId: "room:main-conflict",
      laneKey: "room:main-conflict",
    };
    expect(
      (await postApproval({ ...basePayload, verb: "once" })).statusCode,
    ).toBe(200);
    await waitFor(() => resumeSpy.mock.calls.length === 1);
    const conflict = await postApproval({ ...basePayload, verb: "deny" });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({
      code: "approval_decision_conflict",
    });
    expect(resumeSpy).toHaveBeenCalledTimes(1);
  });

  test("task approval route emits after canonical task resume and dedupes retry", async () => {
    const collected: ServerEvent[] = [];
    const handler = (event: ServerEvent) => collected.push(event);
    eventBus.on(handler);
    try {
      const payload = {
        verb: "deny",
        approvalId: "task-idempotent",
        threadId: "task-thread",
        laneKey: "task:d440-task",
      };
      expect((await postApproval(payload)).statusCode).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect((await postApproval(payload)).statusCode).toBe(200);

      expect(taskResumeSpy).toHaveBeenCalledTimes(1);
      expect(taskResumeSpy.mock.calls[0]?.[0]).toMatchObject({
        approvalId: "task-idempotent",
      });
      const resolved = approvalEvents(collected);
      expect(resolved).toHaveLength(1);
      expect(resolved[0]).toMatchObject({
        approvalId: "task-idempotent",
        userId: OWNER_ID,
        resolution: "denied",
        taskId: "d440-task",
        taskRunId: "d440-task-run",
        origin: "task",
      });
    } finally {
      eventBus.off(handler);
    }
  });

  test("task prove-it route forwards the optional canonical challenge identity", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/prove-and-resume",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      payload: {
        denied: true,
        challengeId: "task-prove-exact",
        threadId: "task-thread",
        laneKey: "task:d440-task",
      },
    });

    expect(response.statusCode).toBe(200);
    await waitFor(() => taskResumeSpy.mock.calls.length === 1);
    expect(taskResumeSpy.mock.calls[0]?.[0]).toMatchObject({
      kind: "prove_it",
      approved: false,
      challengeId: "task-prove-exact",
    });
  });

  test("does not resolve stale task approval A when canonical B remains parked", async () => {
    taskResumeSpy
      .mockResolvedValueOnce({ reparked: true, staleReply: true })
      .mockResolvedValueOnce({ reparked: true, staleReply: true });
    const collected: ServerEvent[] = [];
    const handler = (event: ServerEvent) => collected.push(event);
    eventBus.on(handler);
    try {
      const response = await postApproval({
        verb: "once",
        approvalId: "task-stale-a",
        threadId: "task-thread",
        laneKey: "task:d440-task",
      });
      expect(response.statusCode).toBe(200);
      await waitFor(() => taskResumeSpy.mock.calls.length === 1);
      expect((await postApproval({
        verb: "once",
        approvalId: "task-stale-a",
        threadId: "task-thread",
        laneKey: "task:d440-task",
      })).statusCode).toBe(200);
      await waitFor(() => taskResumeSpy.mock.calls.length === 2);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(taskResumeSpy).toHaveBeenCalledTimes(2);
      expect(approvalEvents(collected)).toHaveLength(0);
    } finally {
      eventBus.off(handler);
    }
  });
});

interface MockWs {
  readyState: number;
  OPEN: number;
  sent: string[];
  send(payload: string): void;
  on(event: "close", handler: () => void): void;
}

function makeClient(): MockWs {
  return {
    readyState: 1,
    OPEN: 1,
    sent: [],
    send(payload) {
      this.sent.push(payload);
    },
    on() {},
  };
}

describe("D440 approval.resolved WS privacy", () => {
  test("routes only to the requester, never another room member", () => {
    const requester = makeClient();
    const peer = makeClient();
    const roomId = "11111111-1111-4111-8111-111111111111";
    addClient(requester as unknown as WsWebSocket, {
      userId: OWNER_ID,
      actorId: OWNER_ACTOR_ID,
      roomIds: new Set([roomId]),
    });
    addClient(peer as unknown as WsWebSocket, {
      userId: "d440-peer",
      actorId: "d440-peer-actor",
      roomIds: new Set([roomId]),
    });

    broadcast({
      type: "approval.resolved",
      approvalId: "private-resolution",
      threadId: `room:${roomId}`,
      laneKey: `room:${roomId}`,
      userId: OWNER_ID,
      resolution: "approved",
      verb: "once",
    });

    expect(requester.sent).toHaveLength(1);
    expect(JSON.parse(requester.sent[0]!)).toMatchObject({
      type: "approval.resolved",
      approvalId: "private-resolution",
    });
    expect(peer.sent).toHaveLength(0);
  });
});
