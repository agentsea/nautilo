import { describe, expect, test } from "bun:test";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { videoGenerationRoutes } from "../../src/video-generation/routes";
import { normalizeMediaGenerationIntent } from "../../../agent/src/media-generation/contracts";

const body = {
  roomId: "22222222-2222-4222-8222-222222222222",
  projectArtifactId: "55555555-5555-4555-8555-555555555555",
  requestId: "66666666-6666-4666-8666-666666666666",
  shotId: "shot-1",
  shotLabel: "Opening",
  briefDigest: `sha256:${"a".repeat(64)}`,
  documentRevision: 1,
  job: { modelId: "venice:seedance-2-5-text-to-video-basic", prompt: "A bird crosses a blue sky.", durationSeconds: 5, aspectRatio: "16:9", resolution: "720p", audio: true },
};

const project = {
  id: "44444444-4444-4444-8444-444444444444", artifactId: body.projectArtifactId,
  path: "project.video.html", mimeType: "text/html", size: 1, storageUri: "file:///private", revision: 1,
  createdAt: new Date(), updatedAt: new Date(), deletedAt: null,
};

function attestedProjectRequest(app: FastifyInstance): void {
  app.addHook("preHandler", async (request: FastifyRequest) => {
    request.sessionUserId = "user-1";
    request.memoryEnvelope = {
      ownerId: "user-1", roomId: body.roomId, agentId: "agent-1", writableNamespaces: ["namespace-1"],
    } as never;
  });
}

describe("D378 Video generation injected routes", () => {
  test("forwards a complete non-ASCII prompt to canonical model validation", async () => {
    const app = Fastify();
    attestedProjectRequest(app);
    const prompt = "景".repeat(15_000);
    let received: unknown;
    videoGenerationRoutes(app, {
      attestFirstPartyVideo: async () => true,
      async findProjectArtifact() { return project; },
      coordinator: {
        async prepare(input) {
          received = normalizeMediaGenerationIntent(input.intent).prompt;
          return { ok: false, code: "quote_unavailable", recovery: "No provider called by this test." };
        },
        async submit() { throw new Error("No paid submission expected"); },
      },
    });
    try {
      const response = await app.inject({ method: "POST", url: "/api/video-generations/prepare", payload: { ...body, job: { ...body.job, prompt } } });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ code: "quote_unavailable" });
      expect(received).toBe(prompt);
      expect(() => normalizeMediaGenerationIntent({ model: "seedance-2-5-text-to-video-basic", prompt: `${prompt}x` })).toThrow();
    } finally {
      await app.close();
    }
  });

  test("denies an unattested caller before parsing or provider work", async () => {
    const app = Fastify();
    attestedProjectRequest(app);
    videoGenerationRoutes(app, { attestFirstPartyVideo: async () => false, async findProjectArtifact() { return project; } });
    const response = await app.inject({ method: "POST", url: "/api/video-generations/prepare", payload: body });
    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body)).toEqual({ error: "First-party Video host required" });
    await app.close();
  });

  test("an attested caller without the exact authenticated Room/project scope still sees no target", async () => {
    const app = Fastify();
    videoGenerationRoutes(app, {
      attestFirstPartyVideo: async () => true,
      async findProjectArtifact() { return project; },
    });
    const response = await app.inject({ method: "POST", url: "/api/video-generations/prepare", payload: body });
    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body)).toEqual({ error: "Not found" });
    await app.close();
  });

  test("list and status recheck the same project attestation before exposing a take", async () => {
    const app = Fastify();
    attestedProjectRequest(app);
    videoGenerationRoutes(app, { attestFirstPartyVideo: async () => false, async findProjectArtifact() { return project; } });
    const list = await app.inject({ method: "GET", url: `/api/video-generations?roomId=${body.roomId}&projectArtifactId=${body.projectArtifactId}` });
    const status = await app.inject({ method: "GET", url: `/api/video-generations/take_${"a".repeat(16)}/status?roomId=${body.roomId}&projectArtifactId=${body.projectArtifactId}` });
    expect(list.statusCode).toBe(403);
    expect(status.statusCode).toBe(403);
    await app.close();
  });
});
