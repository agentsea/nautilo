import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import * as db from "@nautilo/db";
import * as trust from "@nautilo/trust";
import * as directDb from "../../../src/lib/server-direct-db";
import { chatGPTPlanRoutes } from "../../../src/routes/chatgpt-plan";

const userId = "11111111-1111-4111-8111-111111111111";
const spies: Array<{ mockRestore: () => void }> = [];
const apps: FastifyInstance[] = [];
let capabilities: string[]; let enabled: boolean;
beforeEach(() => {
  capabilities = ["use_personal_provider_credentials"]; enabled = true;
  spies.push(spyOn(trust, "getUserCapabilities").mockImplementation(async () => capabilities));
  spies.push(spyOn(db, "getServerProviderPolicy").mockImplementation(async () => ({ allowPersonalProviderKeys: enabled, fundingPreference: "personal_first", updatedAt: new Date() })));
  spies.push(spyOn(directDb, "getServerDirectDb").mockReturnValue({} as ReturnType<typeof directDb.getServerDirectDb>));
  spies.push(spyOn(db, "listChatGPTRegistrations").mockResolvedValue([]));
  spies.push(spyOn(db, "getChatGPTRuntimeIdentity").mockResolvedValue("22222222-2222-4222-8222-222222222222"));
});
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); for (const spy of spies.splice(0)) spy.mockRestore(); });
function app(human: string | null = userId) {
  const server = Fastify({ logger: false }); apps.push(server);
  server.decorateRequest("sessionUserId", null);
  server.addHook("preHandler", async request => { if (human) request.sessionUserId = human; });
  chatGPTPlanRoutes(server); return server;
}
test("account management requires an authenticated permitted Human", async () => {
  const unauthenticated = await app(null).inject({ method: "GET", url: "/api/account/chatgpt" });
  expect(unauthenticated.statusCode).toBe(403); expect(unauthenticated.json<Record<string, unknown>>()).toEqual({ error: "authentication_required" });
  capabilities = [];
  const denied = await app().inject({ method: "GET", url: "/api/account/chatgpt" });
  expect(denied.statusCode).toBe(403); expect(denied.json<Record<string, unknown>>()).toEqual({ error: "personal_credentials_forbidden" });
});
test("disabled policy permits inspection but refuses enrollment", async () => {
  enabled = false; const server = app();
  const state = await server.inject({ method: "GET", url: "/api/account/chatgpt" });
  expect(state.statusCode).toBe(200); expect(state.json<Record<string, unknown>>()).toMatchObject({ enabled: false, accounts: [] });
  const start = await server.inject({ method: "POST", url: "/api/account/chatgpt/sign-in", payload: {} });
  expect(start.json<Record<string, unknown>>()).toEqual({ error: "personal_credentials_disabled" });
});
test("remote clients cannot start a misleading loopback sign-in", async () => {
  const response = await app().inject({ method: "POST", url: "/api/account/chatgpt/sign-in", remoteAddress: "192.0.2.20", headers: { host: "example.com" }, payload: {} });
  expect(response.statusCode).toBe(409); expect(response.json<Record<string, unknown>>()).toEqual({ error: "local_enrollment_required" });
});
test("selection passes the authenticated owner and rejects foreign registrations", async () => {
  let received: unknown[] = [];
  spies.push(spyOn(db, "selectChatGPTRegistration").mockImplementation(async (_database, owner, id) => { received = [owner, id]; return false; }));
  const id = "33333333-3333-4333-8333-333333333333";
  const response = await app().inject({ method: "PUT", url: "/api/account/chatgpt/selection", payload: { accountId: id } });
  expect(received).toEqual([userId, id]); expect(response.statusCode).toBe(409);
});
