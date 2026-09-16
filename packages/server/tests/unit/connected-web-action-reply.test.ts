import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import { PinChallengeProvider } from "@nautilo/trust";
import { authRoutes } from "../../src/routes/auth";
import { SessionStore } from "../helpers/test-session-store";
import { installLocalAuthPreHandlerStub } from "./helpers/auth-preHandler-stub";
import {
  installProductionLiveShadowMessageComposition,
  uninstallProductionLiveShadowMessageComposition,
  type ProductionLiveShadowMessageComposition,
} from "../../src/routes/live-shadow-message-composition";

let app: FastifyInstance; let token: string;
const userId = "owner"; const actorId = "actor";
const roomId = "11111111-1111-4111-8111-111111111111";
const threadId = `room:${roomId}:user:${actorId}:bot:agent`;
const laneKey = `room:${roomId}:bot:agent`;
const event = { type: "connected_web.action_attention" as const, threadId, laneKey, toolCallId: "tool", userId,
  intervention: { kind: "authentication_required" as const, mode: "reconnect" as const, reason: "mfa" as const, account: { id: "account", label: "Site", service: "Site", origin: "https://site.test" } } };
const raceEvent = { ...event, toolCallId: "tool-race" };

beforeAll(async () => {
  const sessions = new SessionStore(undefined, { persistPath: null }); app = Fastify(); installLocalAuthPreHandlerStub(app, sessions);
  authRoutes(app, { pinProvider: new PinChallengeProvider({ persistPath: null }), ownerId: userId, ownerActorId: actorId, assertCanInvokeAgent: async () => undefined,
    resumeThreadMembershipForUser: async () => true, projectionResumeBindingForThread: async () => ({ kind: "none" }), connectedWebActionPendingForThread: async () => [event, raceEvent], connectedWebActionResumeBindingForThread: async () => ({ agentId: "agent", laneKey }) });
  await app.ready(); token = sessions.createSession(actorId, userId, userId).token;
});
afterAll(async () => { await app.close(); });
async function post(payload: object | string, auth = true): Promise<{ statusCode: number }> {
  return await app.inject({ method: "POST", url: "/api/auth/connected-web-action-reply", headers: auth ? { Authorization: `Bearer ${token}` } : {}, payload }) as unknown as { statusCode: number };
}

describe("connected-web-action-reply", () => {
  test("rejects unauthenticated and malformed replies", async () => {
    expect((await post({}, false)).statusCode).toBe(401);
    expect((await post({ threadId: "thread" })).statusCode).toBe(400);
    expect((await post({ threadId: 7, laneKey, toolCallId: "tool", decision: "done" })).statusCode).toBe(400);
    expect((await post({ threadId, laneKey, toolCallId: "x".repeat(513), decision: "done" })).statusCode).toBe(400);
    expect((await post({ threadId, laneKey: "room:22222222-2222-4222-8222-222222222222:bot:agent", toolCallId: "tool", decision: "done" })).statusCode).toBe(400);
  });
  test("rejects a stale exact tuple", async () => {
    expect((await post({ threadId, laneKey, toolCallId: "other", decision: "done" })).statusCode).toBe(409);
  });
  test("fails closed when protected foreground resume is unavailable", async () => {
    expect((await post({ threadId, laneKey, toolCallId: "tool", decision: "cancel" })).statusCode).toBe(409);
  });
  test("never reports a durable protected-resume replay as either decision succeeding", async () => {
    const composition = {
      reserveSharedAgentRuntimeResume: async () => ({
        status: "replayed" as const,
        cancelRecovery: "unavailable" as const,
      }),
      planSharedAgentExecutionAuthorization: async () => { throw new Error("replayed reservation must not plan"); },
      awaitSharedAgentExecutionAuthorization: async () => { throw new Error("replayed reservation must not await"); },
    } as unknown as ProductionLiveShadowMessageComposition;
    installProductionLiveShadowMessageComposition(app, composition);
    try {
      const binding = { clientActionSessionId: "session", authorizationDeviceId: "device" };
      const [done, cancel] = await Promise.all([
        post({ threadId, laneKey, toolCallId: "tool-race", decision: "done", ...binding }),
        post({ threadId, laneKey, toolCallId: "tool-race", decision: "cancel", ...binding }),
      ]);
      expect([done.statusCode, cancel.statusCode].sort()).toEqual([409, 409]);
    } finally {
      uninstallProductionLiveShadowMessageComposition(app);
    }
  });
});
