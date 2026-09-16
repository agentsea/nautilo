import { expect, test } from "bun:test";
import Fastify from "fastify";
import { claudeConnectionsRoutes } from "../../src/routes/claude-connections";

const summary = { enabled: false, selectedModel: null, selectedModelAdmitted: false, runtime: { state: "unavailable" }, account: { state: "unavailable" }, catalog: { state: "unavailable", complete: false, models: [] }, connectionState: "disabled", observedAt: null, observationStale: true } as const;

test("Claude Connections routes require an owner and forward only the exact relay hint", async () => {
  const app = Fastify(); let seen: unknown[] = [];
  app.addHook("onRequest", (request, _reply, done) => { (request as unknown as { sessionUserId: string | null; policyContext: object }).sessionUserId = request.headers.authorization === "owner" ? "owner" : null; (request as unknown as { policyContext: object }).policyContext = {}; done(); });
  claudeConnectionsRoutes(app, { controller: {
    summary: async (...input: unknown[]) => { seen = input; return summary; }, setEnabled: async () => summary, checkAgain: async () => summary, selectModel: async () => summary, close: () => undefined,
  } as never });
  expect((await app.inject({ method: "GET", url: "/api/claude-connections" })).statusCode).toBe(401);
  expect((await app.inject({ method: "GET", url: "/api/claude-connections", headers: { authorization: "owner", "x-nautilo-claude-relay-id": "relay-a" } })).statusCode).toBe(200);
  expect(seen).toEqual(["owner", "relay-a"]);
  expect((await app.inject({ method: "POST", url: "/api/claude-connections/toggle", headers: { authorization: "owner" }, payload: { enabled: "yes" } })).statusCode).toBe(400);
  await app.close();
});
