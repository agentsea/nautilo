/**
 * Route-level /api/chat — attachment rejections become 202 + `attachments[]`, never 500.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";

const createForegroundJob = mock(() =>
  Promise.resolve({
    id: "job-route-test",
    virtualJobId: "job-route-test",
  }),
);
const ROOM_ID = "11111111-1111-4111-8111-111111111111";
const loadRoomRoster = mock((_roomId: string) => Promise.resolve([]));

import { chatRoutes } from "../../src/routes/chat";
import {
  AgentInvocationDeniedError,
  setBootstrapOwnerId,
  getBootstrapOwnerId,
  type AgentInvocationAdmissionInput,
} from "@nautilo/trust";

let prevOwnerId: string;

beforeAll(() => {
  prevOwnerId = getBootstrapOwnerId();
  setBootstrapOwnerId("owner-http-test");
});

afterAll(() => {
  setBootstrapOwnerId(prevOwnerId);
});

async function makeChatApp(
  actorRole: "owner" | "guest" = "owner",
  roomId = "",
  extraDeps: {
    replyToMessageInRoom?: (messageId: number, roomId: string) => Promise<boolean>;
    omitPolicyContext?: boolean;
    assertInvocation?: (input: AgentInvocationAdmissionInput) => Promise<void>;
  } = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorateRequest("memoryEnvelope", null);
  app.decorateRequest("policyContext", null);
  app.decorateRequest("sessionUserId", null);
  app.addHook("preHandler", async (request) => {
    if (!extraDeps.omitPolicyContext) {
      (request as unknown as { policyContext: { actorRole: string; speakerTrust: "verified"; laneKey: string; graphThreadId: string } }).policyContext = {
        actorRole,
        speakerTrust: "verified",
        laneKey: "lane:test",
        graphThreadId: "thread:test",
      };
    }
    (request as unknown as { sessionUserId: string }).sessionUserId = `user-${actorRole}`;
    (request as unknown as { memoryEnvelope: { roomId: string; agentId: string; ownerId: string } }).memoryEnvelope = {
      roomId,
      agentId: "agent:test",
      ownerId: getBootstrapOwnerId() || "owner-http-test",
    };
  });
  chatRoutes(app, {
    createForegroundJob,
    loadRoomRoster,
    assertInvocation: async () => {},
    ...extraDeps,
  });
  await app.ready();
  return app;
}

describe("/api/chat route", () => {
  test("403 returns the stable capability denial before creating a legacy foreground job", async () => {
    const app = await makeChatApp("guest", ROOM_ID, {
      assertInvocation: async (input) => {
        throw new AgentInvocationDeniedError(input);
      },
    });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/chat",
        headers: { "content-type": "application/json" },
        payload: { message: "invoke", roomId: ROOM_ID },
      });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body)).toEqual({
        error: "invoke_agents_required",
        code: "invoke_agents_required",
        capability: "invoke_agents",
      });
      expect(createForegroundJob).not.toHaveBeenCalled();
    } finally {
      createForegroundJob.mockClear();
      await app.close();
    }
  });

  test("404 rejects explicit stale room instead of using resolver fallback", async () => {
    const app = await makeChatApp("owner", "22222222-2222-4222-8222-222222222222");
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/chat",
        headers: { "content-type": "application/json" },
        payload: {
          message: "hi",
          laneKey: "app:default",
          roomId: ROOM_ID,
        },
      });
      expect(res.statusCode).toBe(404);
      expect(createForegroundJob).not.toHaveBeenCalled();
    } finally {
      createForegroundJob.mockClear();
      await app.close();
    }
  });

  test("400 rejects malformed explicit room id", async () => {
    const app = await makeChatApp("owner", ROOM_ID);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/chat",
        headers: { "content-type": "application/json" },
        payload: {
          message: "hi",
          laneKey: "app:default",
          roomId: "not-a-room",
        },
      });
      expect(res.statusCode).toBe(400);
      expect(createForegroundJob).not.toHaveBeenCalled();
    } finally {
      createForegroundJob.mockClear();
      await app.close();
    }
  });

  test("400 rejects replyToMessageId when validator returns false", async () => {
    const app = await makeChatApp("owner", ROOM_ID, {
      replyToMessageInRoom: async () => false,
    });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/chat",
        headers: { "content-type": "application/json" },
        payload: {
          message: "hi",
          laneKey: "app:default",
          roomId: ROOM_ID,
          replyToMessageId: 99,
        },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body) as { error?: string };
      expect(body.error).toBe("invalid replyToMessageId");
      expect(createForegroundJob).not.toHaveBeenCalled();
    } finally {
      createForegroundJob.mockClear();
      await app.close();
    }
  });

  test("202 passes replyToMessageId through to foreground job input", async () => {
    const app = await makeChatApp("owner", ROOM_ID, {
      replyToMessageInRoom: async () => true,
    });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/chat",
        headers: { "content-type": "application/json" },
        payload: {
          message: "hi",
          laneKey: "app:default",
          roomId: ROOM_ID,
          replyToMessageId: 42,
        },
      });
      expect(res.statusCode).toBe(202);
      expect(createForegroundJob).toHaveBeenCalled();
      const callArgs = createForegroundJob.mock.calls[0] as unknown as unknown[];
      const jobInput = callArgs[3] as Record<string, unknown>;
      expect(jobInput["replyToMessageId"]).toBe(42);
    } finally {
      createForegroundJob.mockClear();
      await app.close();
    }
  });

  test("forwards authenticated Human Auto-Approve and defaults omitted posture off", async () => {
    const app = await makeChatApp("owner");
    try {
      const enabled = await app.inject({
        method: "POST",
        url: "/api/chat",
        headers: { "content-type": "application/json" },
        payload: { message: "trusted SSH work", autoApprove: true },
      });
      expect(enabled.statusCode).toBe(202);
      const jobCalls = createForegroundJob.mock.calls as unknown as Array<unknown[]>;
      const enabledInput = jobCalls[0]?.[3] as Record<string, unknown>;
      expect(enabledInput["autoApprove"]).toBe(true);

      createForegroundJob.mockClear();
      const omitted = await app.inject({
        method: "POST",
        url: "/api/chat",
        headers: { "content-type": "application/json" },
        payload: { message: "legacy turn" },
      });
      expect(omitted.statusCode).toBe(202);
      const omittedCalls = createForegroundJob.mock.calls as unknown as Array<unknown[]>;
      const omittedInput = omittedCalls[0]?.[3] as Record<string, unknown>;
      expect(omittedInput["autoApprove"]).toBe(false);
    } finally {
      createForegroundJob.mockClear();
      await app.close();
    }
  });

  test("does not use a Role name as an Auto-Approve authority input", async () => {
    const app = await makeChatApp("guest");
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/chat",
        headers: { "content-type": "application/json" },
        payload: { message: "bypass review", autoApprove: true },
      });
      expect(res.statusCode).toBe(202);
      const jobCalls = createForegroundJob.mock.calls as unknown as Array<unknown[]>;
      const jobInput = jobCalls[0]?.[3] as Record<string, unknown>;
      expect(jobInput["autoApprove"]).toBe(true);
    } finally {
      createForegroundJob.mockClear();
      await app.close();
    }
  });

  test("does not forward Auto-Approve through a legacy request missing policy context", async () => {
    const app = await makeChatApp("owner", "", { omitPolicyContext: true });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/chat",
        headers: { "content-type": "application/json" },
        payload: { message: "legacy bypass", autoApprove: true },
      });
      expect(res.statusCode).toBe(202);
      const jobCalls = createForegroundJob.mock.calls as unknown as Array<unknown[]>;
      const jobInput = jobCalls[0]?.[3] as Record<string, unknown>;
      expect(jobInput["autoApprove"]).toBe(false);
    } finally {
      createForegroundJob.mockClear();
      await app.close();
    }
  });
});
