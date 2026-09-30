import { afterEach, describe, expect, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import { profileRoutes } from "../../src/routes/profile";
import type { CallerModelAvailability } from "../../src/routes/config";

/**
 * D141 P2 / LD-1 — validation + auth gates for `PATCH /api/profile/fallback`.
 *
 * Happy-path DB writes need a real database fixture; those live in
 * the integration-test layer alongside other route-DB tests. This
 * file pins the cheap-to-test gates: auth, body-shape validation,
 * and chain-entry catalog validation. All three reject BEFORE the
 * route reaches `updateFallbackPolicy`, so no DB is required.
 */
describe("PATCH /api/profile/fallback — validation + auth gates", () => {
  const instances: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(instances.splice(0).map((app) => app.close()));
  });

  function makeGuestApp(): FastifyInstance {
    const app = Fastify({ logger: false });
    app.decorateRequest("policyContext", null);
    app.decorateRequest("memoryEnvelope", null);
    app.decorateRequest("sessionActorId", null);
    app.decorateRequest("sessionUserId", null);
    profileRoutes(app);
    app.addHook("preHandler", async (request) => {
      request.sessionUserId = null;
      request.policyContext = {
        actorRole: "guest",
        actorId: "guest",
      } as typeof request.policyContext;
    });
    instances.push(app);
    return app;
  }

  function makeOwnerApp(): FastifyInstance {
    const app = Fastify({ logger: false });
    app.decorateRequest("policyContext", null);
    app.decorateRequest("memoryEnvelope", null);
    app.decorateRequest("sessionActorId", null);
    app.decorateRequest("sessionUserId", null);
    profileRoutes(app, { ownerId: "owner-1" });
    app.addHook("preHandler", async (request) => {
      request.sessionUserId = "owner-1";
      request.policyContext = {
        actorRole: "owner",
        actorId: "owner-actor",
      } as typeof request.policyContext;
    });
    instances.push(app);
    return app;
  }

  function makeAgentOwnedFallbackApp(capture: {
    userId?: string;
    agentId?: string;
    policy?: { enabled: boolean; chain: string[] };
  }, resolveCallerAvailability?: (
    humanUserId: string,
    modelId: string,
  ) => Promise<CallerModelAvailability>): FastifyInstance {
    const app = Fastify({ logger: false });
    app.decorateRequest("policyContext", null);
    app.decorateRequest("memoryEnvelope", null);
    app.decorateRequest("sessionActorId", null);
    app.decorateRequest("sessionUserId", null);
    profileRoutes(app, {
      findPersonalAgentsForUser: async (userId) => {
        capture.userId = userId;
        return [{ agentId: "agent-1", handle: "genie", displayName: "Genie" }];
      },
      updateFallbackPolicy: async (agentId, policy) => {
        capture.agentId = agentId;
        capture.policy = policy;
        return { fallbackEnabled: policy.enabled, fallbackChain: policy.chain };
      },
      ...(resolveCallerAvailability ? { resolveCallerAvailability } : {}),
    });
    app.addHook("preHandler", async (request) => {
      request.sessionUserId = "human-1";
      request.policyContext = {
        actorRole: "contributor",
        actorId: "human-actor-1",
      } as typeof request.policyContext;
    });
    instances.push(app);
    return app;
  }

  test("guest viewer is rejected 401", async () => {
    const app = makeGuestApp();

    const res = await app.inject({
      method: "PATCH",
      url: "/api/profile/fallback",
      payload: { enabled: true, chain: [] },
    });

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: "Authentication required" });
  });

  test("profile default mutation rejects an unavailable exact model before DB access", async () => {
    const app = makeOwnerApp();
    const res = await app.inject({
      method: "PUT",
      url: "/api/profile",
      payload: { defaultModel: "legacy:not-signed" },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      code: "model_unavailable",
      model: { modelId: "legacy:not-signed", availability: "unknown-model" },
    });
  });

  test("profile default validation uses the authenticated Human's funding projection", async () => {
    const callers: Array<{ humanUserId: string; modelId: string }> = [];
    const app = Fastify({ logger: false });
    app.decorateRequest("policyContext", null);
    app.decorateRequest("memoryEnvelope", null);
    app.decorateRequest("sessionActorId", null);
    app.decorateRequest("sessionUserId", null);
    app.addHook("preHandler", async (request) => {
      request.sessionUserId = "human-1";
      request.policyContext = { actorRole: "contributor", actorId: "human-actor-1" } as typeof request.policyContext;
    });
    profileRoutes(app, {
      findPersonalAgentsForUser: async () => [],
      resolveCallerAvailability: async (humanUserId, modelId) => {
        callers.push({ humanUserId, modelId });
        return {
          model: {
            id: modelId,
            displayName: modelId,
            provider: "anthropic",
            priority: 1,
            costCoefficient: 1,
            enabled: true,
            capabilities: { tools: false, vision: false, reasoning: true, e2ee: false, webSearch: false },
            availability: "selectable",
          },
          funding: {
            kind: "personal",
            humanUserId,
            payerHumanId: humanUserId,
            credentialId: "credential-1",
            credentialRevision: 2,
            modelId,
            providerRoute: "anthropic",
            workload: "foreground_text_chat",
          },
          selectableInThisRelease: true,
        };
      },
    });
    instances.push(app);

    const res = await app.inject({
      method: "PUT",
      url: "/api/profile",
      payload: { defaultModel: "anthropic:claude-sonnet-4-6" },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>()).toEqual({ error: "no_personal_agent" });
    expect(callers).toEqual([
      { humanUserId: "human-1", modelId: "anthropic:claude-sonnet-4-6" },
    ]);
  });

  test("fallback mutation rejects unavailable rows before DB access", async () => {
    const app = makeOwnerApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/profile/fallback",
      payload: { enabled: true, chain: ["legacy:not-signed"] },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      code: "model_unavailable",
      models: [{ modelId: "legacy:not-signed", availability: "unknown-model" }],
    });
  });

  test("fallback mutation resolves the current Human's Agent and writes by Agent ID", async () => {
    const capture: {
      userId?: string;
      agentId?: string;
      policy?: { enabled: boolean; chain: string[] };
    } = {};
    const app = makeAgentOwnedFallbackApp(capture);
    const res = await app.inject({
      method: "PATCH",
      url: "/api/profile/fallback",
      payload: { enabled: true, chain: [] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ enabled: boolean; chain: string[] }>()).toEqual({
      enabled: true,
      chain: [],
    });
    expect(capture).toEqual({
      userId: "human-1",
      agentId: "agent-1",
      policy: { enabled: true, chain: [] },
    });
  });

  test("fallback selection accepts the authenticated Human's personally funded model", async () => {
    const capture: {
      userId?: string;
      agentId?: string;
      policy?: { enabled: boolean; chain: string[] };
    } = {};
    const callers: Array<{ humanUserId: string; modelId: string }> = [];
    const app = makeAgentOwnedFallbackApp(capture, async (humanUserId, modelId) => {
      callers.push({ humanUserId, modelId });
      return {
        model: {
          id: modelId,
          displayName: modelId,
          provider: "anthropic",
          priority: 1,
          costCoefficient: 1,
          enabled: true,
          capabilities: { tools: false, vision: false, reasoning: true, e2ee: false, webSearch: false },
          availability: "selectable",
        },
        funding: {
          kind: "personal",
          humanUserId,
          payerHumanId: humanUserId,
          credentialId: "credential-1",
          credentialRevision: 2,
          modelId,
          providerRoute: "anthropic",
          workload: "foreground_text_chat",
        },
        selectableInThisRelease: true,
      };
    });
    const res = await app.inject({
      method: "PATCH",
      url: "/api/profile/fallback",
      payload: { enabled: true, chain: ["anthropic:claude-sonnet-4-6"] },
    });

    expect(res.statusCode).toBe(200);
    expect(callers).toEqual([
      { humanUserId: "human-1", modelId: "anthropic:claude-sonnet-4-6" },
    ]);
    expect(capture.policy).toEqual({
      enabled: true,
      chain: ["anthropic:claude-sonnet-4-6"],
    });
  });

});
