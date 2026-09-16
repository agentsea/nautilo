import { beforeEach, describe, expect, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { ModelControlSelection } from "@nautilo/types";
import { modelControlSelectionRoutes } from "../../src/routes/model-control-selections";

const USER_ID = "user-1";
const USER_ACTOR_ID = "actor-1";
const AGENT_ID = "agent-1";
const SECONDARY_AGENT_ID = "secondary-agent";
const ROOM_ID = "room-1";

function buildApp(assertRunnableSelection: (modelId: string) => void = () => {}): {
  app: FastifyInstance;
  getCalls: Array<{ roomId: string; agentId: string }>;
  setCalls: Array<{ roomId: string; agentId: string; selection: ModelControlSelection }>;
  resetCalls: Array<{ roomId: string; agentId: string }>;
} {
  const getCalls: Array<{ roomId: string; agentId: string }> = [];
  const setCalls: Array<{ roomId: string; agentId: string; selection: ModelControlSelection }> = [];
  const resetCalls: Array<{ roomId: string; agentId: string }> = [];
  const selection: ModelControlSelection = {
    modelId: "fireworks:accounts/fireworks/models/kimi-k3",
    servingProfileId: "fast",
  };
  const app = Fastify();
  app.decorateRequest("sessionUserId", null);
  app.decorateRequest("sessionActorId", null);
  app.addHook("preHandler", async (request) => {
    request.sessionUserId = request.headers["x-test-user"] === USER_ID ? USER_ID : null;
    request.sessionActorId = request.headers["x-test-actor"] === USER_ACTOR_ID ? USER_ACTOR_ID : null;
  });
  modelControlSelectionRoutes(app, {
    findPersonalAgentsForUser: async (userId) =>
      userId === USER_ID ? [{ agentId: AGENT_ID }, { agentId: SECONDARY_AGENT_ID }] : [],
    findRoomForUserAndAgentMembers: async (roomId, userActorId, agentId) =>
      roomId === ROOM_ID &&
      userActorId === USER_ACTOR_ID &&
      (agentId === AGENT_ID || agentId === SECONDARY_AGENT_ID)
        ? {}
        : null,
    getSelection: async (roomId, agentId) => {
      getCalls.push({ roomId, agentId });
      return agentId === AGENT_ID
        ? selection
        : { modelId: "fireworks:accounts/fireworks/models/kimi-k3", reasoningEffort: "high" };
    },
    setSelection: async (roomId, agentId, input) => {
      setCalls.push({ roomId, agentId, selection: input });
      return input;
    },
    resetSelection: async (roomId, agentId) => {
      resetCalls.push({ roomId, agentId });
    },
    getCatalogEntries: () => [
      {
        id: "fireworks:accounts/fireworks/models/kimi-k3",
        controls: {
          reasoning: { levels: ["low", "high"], canDisable: true, mandatory: false },
          serving: { profiles: [{ id: "priority" }, { id: "fast" }] },
        },
      },
    ],
    assertRunnableSelection,
  });
  return { app, getCalls, setCalls, resetCalls };
}

describe("D462 room model-control selection routes", () => {
  let app: FastifyInstance;
  let getCalls: Array<{ roomId: string; agentId: string }>;
  let setCalls: Array<{ roomId: string; agentId: string; selection: ModelControlSelection }>;
  let resetCalls: Array<{ roomId: string; agentId: string }>;

  beforeEach(() => {
    ({ app, getCalls, setCalls, resetCalls } = buildApp());
  });

  test("requires an authenticated user", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/rooms/${ROOM_ID}/agents/${AGENT_ID}/model-control-selection`,
    });
    expect(response.statusCode).toBe(401);
    expect(getCalls).toEqual([]);
  });

  test("does not reveal selections for a Room the current user/Agent cannot both access", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/rooms/other-room/agents/${AGENT_ID}/model-control-selection`,
      headers: { "x-test-user": USER_ID, "x-test-actor": USER_ACTOR_ID },
    });
    expect(response.statusCode).toBe(404);
    expect(getCalls).toEqual([]);
  });

  test("reads only the explicitly targeted owned Agent's Room selection", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/rooms/${ROOM_ID}/agents/${AGENT_ID}/model-control-selection`,
      headers: { "x-test-user": USER_ID, "x-test-actor": USER_ACTOR_ID },
    });
    expect(response.statusCode).toBe(200);
    const body: unknown = response.json();
    expect(body).toEqual({
      selection: {
        modelId: "fireworks:accounts/fireworks/models/kimi-k3",
        servingProfileId: "fast",
      },
    });
    expect(getCalls).toEqual([{ roomId: ROOM_ID, agentId: AGENT_ID }]);
  });

  test("keeps multiple owned Agents' Room selections isolated", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/rooms/${ROOM_ID}/agents/${SECONDARY_AGENT_ID}/model-control-selection`,
      headers: { "x-test-user": USER_ID, "x-test-actor": USER_ACTOR_ID },
    });
    expect(response.statusCode).toBe(200);
    const body: unknown = response.json();
    expect(body).toEqual({
      selection: {
        modelId: "fireworks:accounts/fireworks/models/kimi-k3",
        reasoningEffort: "high",
      },
    });
    expect(getCalls).toEqual([{ roomId: ROOM_ID, agentId: SECONDARY_AGENT_ID }]);
  });

  test("does not accept an Agent the viewer does not own", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/rooms/${ROOM_ID}/agents/not-owned-agent/model-control-selection`,
      headers: { "x-test-user": USER_ID, "x-test-actor": USER_ACTOR_ID },
    });
    expect(response.statusCode).toBe(404);
    expect(getCalls).toEqual([]);
  });

  test("strictly writes provider-neutral selection ids", async () => {
    const response = await app.inject({
      method: "PUT",
      url: `/api/rooms/${ROOM_ID}/agents/${AGENT_ID}/model-control-selection`,
      headers: {
        "content-type": "application/json",
        "x-test-user": USER_ID,
        "x-test-actor": USER_ACTOR_ID,
      },
      payload: {
        selection: {
          modelId: "fireworks:accounts/fireworks/models/kimi-k3",
          reasoningEffort: "high",
          servingProfileId: "priority",
        },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(setCalls).toEqual([
      {
        roomId: ROOM_ID,
        agentId: AGENT_ID,
        selection: {
          modelId: "fireworks:accounts/fireworks/models/kimi-k3",
          reasoningEffort: "high",
          servingProfileId: "priority",
        },
      },
    ]);
  });

  test("rejects provider selectors and reset removes only the Room layer", async () => {
    const invalid = await app.inject({
      method: "PUT",
      url: `/api/rooms/${ROOM_ID}/agents/${AGENT_ID}/model-control-selection`,
      headers: {
        "content-type": "application/json",
        "x-test-user": USER_ID,
        "x-test-actor": USER_ACTOR_ID,
      },
      payload: {
        selection: {
          modelId: "fireworks:accounts/fireworks/models/kimi-k3",
          providerSelector: { service_tier: "priority" },
        },
      },
    });
    expect(invalid.statusCode).toBe(422);
    expect(setCalls).toEqual([]);

    const reset = await app.inject({
      method: "PUT",
      url: `/api/rooms/${ROOM_ID}/agents/${AGENT_ID}/model-control-selection`,
      headers: {
        "content-type": "application/json",
        "x-test-user": USER_ID,
        "x-test-actor": USER_ACTOR_ID,
      },
      payload: { selection: null },
    });
    expect(reset.statusCode).toBe(200);
    const resetBody: unknown = reset.json();
    expect(resetBody).toEqual({ selection: null });
    expect(resetCalls).toEqual([{ roomId: ROOM_ID, agentId: AGENT_ID }]);
  });

  test("rejects unknown catalog models and unsupported per-model controls before persistence", async () => {
    const base = {
      method: "PUT" as const,
      url: `/api/rooms/${ROOM_ID}/agents/${AGENT_ID}/model-control-selection`,
      headers: {
        "content-type": "application/json",
        "x-test-user": USER_ID,
        "x-test-actor": USER_ACTOR_ID,
      },
    };
    const invalidSelections = [
      { modelId: "fireworks:accounts/fireworks/models/unknown" },
      {
        modelId: "fireworks:accounts/fireworks/models/kimi-k3",
        reasoningEffort: "max",
      },
      {
        modelId: "fireworks:accounts/fireworks/models/kimi-k3",
        servingProfileId: "standard",
      },
    ];

    for (const selection of invalidSelections) {
      const response = await app.inject({ ...base, payload: { selection } });
      expect(response.statusCode).toBe(422);
    }
    expect(setCalls).toEqual([]);
  });

  test("rejects a signed selection that became unavailable before persistence", async () => {
    await app.close();
    ({ app, setCalls } = buildApp(() => {
      throw new Error("Fireworks credential is not configured");
    }));

    const response = await app.inject({
      method: "PUT",
      url: `/api/rooms/${ROOM_ID}/agents/${AGENT_ID}/model-control-selection`,
      headers: {
        "content-type": "application/json",
        "x-test-user": USER_ID,
        "x-test-actor": USER_ACTOR_ID,
      },
      payload: {
        selection: { modelId: "fireworks:accounts/fireworks/models/kimi-k3" },
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json<Record<string, unknown>>()).toEqual({
      code: "model_unavailable",
      error: "Fireworks credential is not configured",
    });
    expect(setCalls).toEqual([]);
  });
});
