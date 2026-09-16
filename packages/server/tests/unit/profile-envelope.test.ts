import { afterEach, describe, expect, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import { SHELL_AGENT_NAME } from "@nautilo/types";
import { profileRoutes } from "../../src/routes/profile";

describe("profile envelope", () => {
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

  test("guest viewer receives only the public Agent shell", async () => {
    const app = makeGuestApp();

    const res = await app.inject({ method: "GET", url: "/api/profile" });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body).toEqual({
      viewerRole: "guest",
      agent: {
        name: SHELL_AGENT_NAME,
        avatar: { kind: "preset", id: "shell" },
        avatarUrl: "/api/profile/avatar",
      },
    });
    expect(JSON.stringify(body)).not.toContain("soulFile");
    expect(JSON.stringify(body)).not.toContain("federatedId");
    expect(JSON.stringify(body)).not.toContain("userId");
  });
});
