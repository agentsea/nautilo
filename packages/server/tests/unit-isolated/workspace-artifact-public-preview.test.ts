import { expect, test } from "bun:test";
import Fastify from "fastify";
import type { Artifact } from "@nautilo/db";
import { workspaceArtifactsRoutes } from "../../src/routes/workspace-artifacts";

test("exact public reference lookup uses readable namespaces and never exposes storage URIs", async () => {
  const app = Fastify();
  const calls: unknown[] = [];
  let authenticated = true;
  let readable = ["ns-owned"];
  app.decorateRequest("memoryEnvelope", null);
  app.addHook("preHandler", (request, _reply, done) => {
    if (authenticated) request.memoryEnvelope = { memoryMode: "namespace", ownerId: "owner", actorId: "actor", agentId: "agent", roomId: "room", readableNamespaces: readable, mutableNamespaces: [], writableNamespaces: [], toolPolicy: {} } as never;
    done();
  });
  workspaceArtifactsRoutes(app, {
    findArtifactByIdForNamespaces: async input => {
      calls.push(input);
      if (input.artifactId !== "public-reference" || !input.readableNamespaceIds.includes("ns-owned")) return null;
      return { id: "db-reference", artifactId: "public-reference", path: "image.png", mimeType: "image/png", size: 24, revision: 1, storageUri: "file:///private/source", createdAt: new Date(0), updatedAt: new Date(0), deletedAt: null } as Artifact;
    },
    getArtifactNamespaces: async () => ["ns-owned"],
  });
  try {
    const response = await app.inject("/api/workspace/artifacts/by-public-id/public-reference");
    expect(response.statusCode).toBe(200);
    expect(calls).toEqual([{ artifactId: "public-reference", readableNamespaceIds: ["ns-owned"] }]);
    expect(response.json()).toMatchObject({ artifactId: "public-reference", id: "db-reference", canWrite: false });
    expect(response.body).not.toContain("storageUri");
    readable = [];
    const denied = await app.inject("/api/workspace/artifacts/by-public-id/public-reference");
    const missing = await app.inject("/api/workspace/artifacts/by-public-id/missing");
    expect(denied.statusCode).toBe(404); expect(denied.body).toBe(missing.body);
    authenticated = false;
    expect((await app.inject("/api/workspace/artifacts/by-public-id/public-reference")).statusCode).toBe(401);
  } finally { await app.close(); }
});
