import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import * as db from "@nautilo/db";
import { ChatGPTOAuth, parseChatGPTCallback, CHATGPT_ISSUER } from "../../../src/lib/chatgpt-plan/oauth";
import { chatGPTSessionStore } from "../../../src/lib/chatgpt-plan/runtime";
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
function app(human: string | null | (() => string | null) = userId, continuation = async () => true) {
  const server = Fastify({ logger: false }); apps.push(server);
  server.decorateRequest("sessionUserId", null);
  server.addHook("preHandler", async request => { request.sessionUserId = typeof human === "function" ? human() : human; });
  chatGPTPlanRoutes(server, continuation); return server;
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

function fakeExchange() {
  const exchange = spyOn(ChatGPTOAuth.prototype, "exchange").mockImplementation(async (attempt, callback, signal) => {
    const parsed = parseChatGPTCallback(attempt, callback); signal.throwIfAborted();
    return { identity: { issuer: CHATGPT_ISSUER, subject: "synthetic-subject", clientId: parsed.clientId, hostId: attempt.hostId },
      accessToken: "synthetic-access", refreshToken: "synthetic-refresh", idToken: "synthetic-id", scopes: [], expiresAt: 1, receivedAt: 1 };
  });
  const connect = spyOn(chatGPTSessionStore, "connect").mockImplementation(async (_userId, _session, signal) => { signal.throwIfAborted(); return "synthetic-registration"; });
  const remember = spyOn(chatGPTSessionStore, "rememberRegistration").mockResolvedValue({ id: "33333333-3333-4333-8333-333333333333", authorityRevision: 1 });
  spies.push(exchange, connect, remember);
  return { exchange, connect, remember };
}
async function remoteStart(server: FastifyInstance) {
  const response = await server.inject({ method: "POST", url: "/api/account/chatgpt/sign-in", remoteAddress: "192.0.2.20", payload: { desktopPort: 32123 } });
  expect(response.statusCode).toBe(200);
  const start = response.json<{ attemptId: string; authorizationUrl: string }>();
  const authorization = new URL(start.authorizationUrl);
  const callback = new URL(authorization.searchParams.get("redirect_uri")!);
  callback.search = new URLSearchParams({ code: "synthetic-code", state: authorization.searchParams.get("state")!, client_id: "oaiapp_synthetic" }).toString();
  expect(authorization.searchParams.get("ext_agent_host_id")).toBe("urn:uuid:22222222-2222-4222-8222-222222222222");
  expect(start).not.toHaveProperty("verifier");
  return { url: `/api/account/chatgpt/sign-in/${start.attemptId}/complete`, callbackUrl: callback.toString(), attemptId: start.attemptId };
}
test("remote completion is Human-owned, single-use and cannot run on another instance", async () => {
  const { exchange, connect } = fakeExchange();
  let human = userId; const server = app(() => human);
  const start = await remoteStart(server);
  human = "33333333-3333-4333-8333-333333333333";
  expect((await server.inject({ method: "POST", url: start.url, payload: { callbackUrl: start.callbackUrl } })).statusCode).toBe(409);
  human = userId;
  expect((await app().inject({ method: "POST", url: start.url, payload: { callbackUrl: start.callbackUrl } })).statusCode).toBe(409);
  const completed = await server.inject({ method: "POST", url: start.url, payload: { callbackUrl: start.callbackUrl } });
  expect(completed.json<Record<string, unknown>>()).toEqual({ status: "connected" });
  expect((await server.inject({ method: "POST", url: start.url, payload: { callbackUrl: start.callbackUrl } })).statusCode).toBe(409);
  expect(exchange).toHaveBeenCalledTimes(1); expect(connect).toHaveBeenCalledTimes(1);
  expect(connect.mock.calls[0]?.[0]).toBe(userId);
});
test("wrong state consumes no saved account and cannot be retried", async () => {
  const { connect } = fakeExchange(); const server = app(); const start = await remoteStart(server);
  const callback = new URL(start.callbackUrl); callback.searchParams.set("state", "wrong");
  const response = await server.inject({ method: "POST", url: start.url, payload: { callbackUrl: callback.toString() } });
  expect(response.json<Record<string, unknown>>()).toEqual({ status: "failed", code: "authorization_invalid" });
  expect(connect).not.toHaveBeenCalled();
  expect((await server.inject({ method: "POST", url: start.url, payload: { callbackUrl: start.callbackUrl } })).statusCode).toBe(409);
});
test("superseded, cancelled and revoked sessions cannot complete enrollment", async () => {
  const { connect } = fakeExchange(); const server = app(userId, async () => false);
  const old = await remoteStart(server); const current = await remoteStart(server);
  expect((await server.inject({ method: "POST", url: old.url, payload: { callbackUrl: old.callbackUrl } })).statusCode).toBe(409);
  expect((await server.inject({ method: "POST", url: current.url, payload: { callbackUrl: current.callbackUrl } })).json<Record<string, unknown>>()).toEqual({ status: "failed", code: "authorization_expired" });
  const next = await remoteStart(server);
  await server.inject({ method: "DELETE", url: `/api/account/chatgpt/sign-in/${next.attemptId}` });
  expect((await server.inject({ method: "POST", url: next.url, payload: { callbackUrl: next.callbackUrl } })).statusCode).toBe(409);
  expect(connect).not.toHaveBeenCalled();
});

test("failed first exchange retains issued registration before exchange and never connects it", async () => {
  const { exchange, connect, remember } = fakeExchange();
  exchange.mockImplementation(async () => { expect(remember).toHaveBeenCalledTimes(1); throw new Error("synthetic failure"); });
  const server = app(); const start = await remoteStart(server);
  const response = await server.inject({ method: "POST", url: start.url, payload: { callbackUrl: start.callbackUrl } });
  expect(response.json<Record<string, unknown>>()).toEqual({ status: "failed", code: "provider_unavailable" });
  expect(remember.mock.calls[0]?.[0]).toBe(userId);
  expect(remember.mock.calls[0]?.[1]).toEqual({ issuer: CHATGPT_ISSUER, clientId: "oaiapp_synthetic",
    hostId: "urn:uuid:22222222-2222-4222-8222-222222222222", pending: true });
  expect(connect).not.toHaveBeenCalled();
});
