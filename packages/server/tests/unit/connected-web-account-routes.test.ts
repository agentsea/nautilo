import { expect, test } from "bun:test";
import Fastify from "fastify";
import { ConnectedWebAccountControllerError } from "../../src/connected-web-accounts/controller";
import {
  connectedWebAccountRoutes,
  type ConnectedWebAccountRoutesController,
} from "../../src/routes/connected-web-accounts";

test("connected website paid routes return the stable server-funding denial", async () => {
  const app = Fastify({ logger: false });
  app.addHook("preHandler", async (request) => {
    request.sessionUserId = "11111111-1111-4111-8111-111111111111";
    request.policyContext = { actorRole: "community" } as never;
  });
  connectedWebAccountRoutes(app, {
    controller: {
      providerSetupStatus: () => "ready",
      create: async () => { throw new ConnectedWebAccountControllerError("server_funding_required"); },
    } as unknown as ConnectedWebAccountRoutesController,
  });

  const response = await app.inject({
    method: "POST",
    url: "/api/connected-web-accounts",
    payload: {
      service: "Example",
      origin: "https://example.com/login",
      label: "Example",
      createAnother: true,
    },
  });
  expect(response.statusCode).toBe(403);
  const body: unknown = response.json();
  expect(body).toEqual({ error: "server_provider_credentials_required" });
  await app.close();
});
