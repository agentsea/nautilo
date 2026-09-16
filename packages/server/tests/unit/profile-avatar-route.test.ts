import { afterEach, describe, expect, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import { profileAvatarRoutes } from "../../src/routes/profile-avatar";

const OWNER_USER_ID = "11111111-1111-4111-8111-111111111111";

describe("profile avatar routes (hermetic)", () => {
  const instances: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(instances.splice(0).map((app) => app.close()));
  });

  function makeAvatarReadApp(viewerRole: "guest" | "owner" = "guest"): FastifyInstance {
    const app = Fastify({ logger: false });
    app.decorateRequest("policyContext", null);
    app.decorateRequest("memoryEnvelope", null);
    app.decorateRequest("sessionActorId", null);
    app.decorateRequest("sessionUserId", null);
    profileAvatarRoutes(app, { ownerId: OWNER_USER_ID });
    app.addHook("preHandler", async (request) => {
      request.sessionUserId = viewerRole === "guest" ? null : OWNER_USER_ID;
      request.policyContext = {
        actorRole: viewerRole,
        actorId: request.sessionUserId ?? "guest",
      } as typeof request.policyContext;
    });
    instances.push(app);
    return app;
  }

  test("guest viewer gets the canonical shell avatar", async () => {
    const app = makeAvatarReadApp("guest");

    const res = await app.inject({ method: "GET", url: "/api/profile/avatar" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("image/svg+xml");
    // D243 — `no-cache` allows browser caching but forces conditional
    // revalidation via ETag on every read; pre-D243 this was
    // `private, no-store`, which combined with the client cache-buster
    // forced full re-downloads on every refresh.
    expect(res.headers["cache-control"]).toBe("private, no-cache");
    expect(res.headers["vary"]).toBe("Authorization");
    expect(res.body).toContain("Genie shell avatar");
  });

});
