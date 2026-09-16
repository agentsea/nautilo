import { afterEach, expect, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import { workspaceArtifactsRoutes } from "../../src/routes/workspace-artifacts";
import type { WorkspaceAuthoredChangeInput } from "../../src/document-mutations/workspace-authored-change";

const instances: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(instances.splice(0).map((app) => app.close())); });
async function harness(session: string | null = "human", roomId = "room") {
  const calls: WorkspaceAuthoredChangeInput[] = [];
  const app = Fastify();
  instances.push(app);
  app.decorateRequest("memoryEnvelope", null);
  app.decorateRequest("sessionUserId", null);
  app.addHook("preHandler", async (request) => {
    request.sessionUserId = session;
    request.memoryEnvelope = {
      memoryMode: "namespace", ownerId: "owner", actorId: "human-actor", agentId: "agent", roomId,
      readableNamespaces: [], writableNamespaces: [], mutableNamespaces: [], toolPolicy: {},
    };
  });
  workspaceArtifactsRoutes(app, { readAuthoredChange: async (input) => { calls.push(input); return { kind: "none" }; } });
  await app.ready();
  return { app, calls };
}
const query = `roomId=room&expectedRevision=3&expectedSha256=${"a".repeat(64)}`;
test("retained history route takes subject from authenticated context and never caches private snapshots", async () => {
  const { app, calls } = await harness();
  const response = await app.inject(`/api/workspace/artifacts/artifact/authored-change?${query}`);
  expect(response.statusCode).toBe(200);
  expect(response.json<unknown>()).toEqual({ kind: "none" });
  expect(response.headers["cache-control"]).toBe("private, no-store");
  expect(calls[0]).toMatchObject({ artifactId: "artifact", sessionUserId: "human", expectedRevision: 3,
    expectedSha256: "a".repeat(64), envelope: { roomId: "room", agentId: "agent", actorId: "human-actor" } });
});
test("closed query rejects client authority, mismatched Room, malformed version and duplicate keys", async () => {
  const { app, calls } = await harness();
  for (const q of [query + "&ownerId=other", query + "&agentId=other", query.replace("roomId=room", "roomId=private"),
    query.replace("Revision=3", "Revision=-1"), query.replace("Revision=3", "Revision=9007199254740992"),
    query + "&expectedRevision=4", query.replace("a".repeat(64), "not-a-sha")]) {
    expect((await app.inject(`/api/workspace/artifacts/artifact/authored-change?${q}`)).statusCode).toBe(400);
  }
  expect(calls).toEqual([]);
});
test("no authenticated human or current Room never reaches history service", async () => {
  const noSession = await harness(null);
  const noRoom = await harness("human", "");
  expect((await noSession.app.inject(`/api/workspace/artifacts/artifact/authored-change?${query}`)).statusCode).toBe(401);
  expect((await noRoom.app.inject(`/api/workspace/artifacts/artifact/authored-change?${query}`)).statusCode).toBe(403);
  expect([...noSession.calls, ...noRoom.calls]).toEqual([]);
});
