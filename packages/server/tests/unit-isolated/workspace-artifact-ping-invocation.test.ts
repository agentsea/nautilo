import { describe, expect, test } from "bun:test";
import Fastify from "fastify";
import { AgentInvocationDeniedError } from "@nautilo/trust";
import type { Artifact } from "@nautilo/db";
import { workspaceArtifactsRoutes } from "../../src/routes/workspace-artifacts";

const artifact: Artifact = {
  id: "11111111-1111-4111-8111-111111111111",
  artifactId: "artifact-1",
  path: "quiz.html",
  mimeType: "text/html",
  size: 1,
  storageUri: "file:///tmp/quiz.html",
  revision: 1,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  deletedAt: null,
};

async function makeApp() {
  let appended = 0;
  const app = Fastify({ logger: false });
  app.decorateRequest("memoryEnvelope", null);
  app.decorateRequest("sessionUserId", null);
  app.addHook("preHandler", async (request) => {
    request.sessionUserId = "human-1";
    request.memoryEnvelope = {
      memoryMode: "namespace",
      ownerId: "human-1",
      actorId: "actor-1",
      agentId: "agent-1",
      roomId: "room-1",
      readableNamespaces: ["namespace-1"],
      mutableNamespaces: ["namespace-1"],
      writableNamespaces: ["namespace-1"],
      toolPolicy: {},
    } as never;
  });
  workspaceArtifactsRoutes(app, {
    findArtifactByInternalIdForNamespaces: async () => artifact,
    getArtifactNamespaces: async () => ["namespace-1"],
    appendPendingArtifactEvent: async (input) => {
      appended += 1;
      return {
        id: "event-1",
        createdAt: new Date("2026-01-01T00:00:00Z"),
        droppedCount: 0,
        ...input,
      };
    },
    assertCanWriteArtifacts: async () => {},
    assertCanInvokeAgent: async (input) => {
      throw new AgentInvocationDeniedError(input);
    },
  });
  await app.ready();
  return { app, appended: () => appended };
}

describe("M254 waking Artifact ping admission", () => {
  test("denies before event persistence while a non-waking event remains unchanged", async () => {
    const { app, appended } = await makeApp();
    const ping = await app.inject({
      method: "POST",
      url: `/api/workspace/artifacts/${artifact.id}/events/ping`,
      payload: { topic: "answer", payload: { choice: 2 } },
    });
    expect(ping.statusCode).toBe(403);
    expect(JSON.parse(ping.body)).toEqual({
      error: "invoke_agents_required",
      code: "invoke_agents_required",
      capability: "invoke_agents",
    });
    expect(appended()).toBe(0);

    const ordinary = await app.inject({
      method: "POST",
      url: `/api/workspace/artifacts/${artifact.id}/events`,
      payload: { topic: "answer", payload: { choice: 2 } },
    });
    expect(ordinary.statusCode).toBe(200);
    expect(appended()).toBe(1);
    await app.close();
  });
});
