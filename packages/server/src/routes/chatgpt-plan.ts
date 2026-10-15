import { DEFAULT_PROVIDER_TIMEOUT_MS } from "@nautilo/agent";
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { isCloudMode } from "@nautilo/config";
import {
  getChatGPTRuntimeIdentity, getChatGPTRegistration, listChatGPTRegistrations,
  selectChatGPTRegistration, getServerProviderPolicy,
} from "@nautilo/db";
import { getUserCapabilities } from "@nautilo/trust";
import { CHATGPT_ISSUER, ChatGPTOAuth, ChatGPTPlanError, createChatGPTAuthorization, parseChatGPTCallback, type ChatGPTAuthorizationAttempt } from "../lib/chatgpt-plan/oauth";
import { startChatGPTLoopback, type ChatGPTAuthorizationResult } from "../lib/chatgpt-plan/loopback";
import { readChatGPTRegistration } from "../lib/chatgpt-plan/session-store";
import { chatGPTSessionStore, listChatGPTModels } from "../lib/chatgpt-plan/runtime";
import { readPersonalProviderCustody } from "../lib/personal-provider-custody";
import { getServerDirectDb } from "../lib/server-direct-db";

// A browser consent ceremony needs a bounded lifetime independent of requests.
// Expiry leaves saved registrations untouched; the Human can start again.
const SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function sendError(reply: FastifyReply, status: number, body: { error: string }): void { void reply.code(status).send(body); }
function localEnrollment(request: FastifyRequest): boolean {
  return !isCloudMode() && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.raw.socket.remoteAddress ?? "")
    && ["127.0.0.1", "localhost", "[::1]"].includes(request.hostname);
}

export function chatGPTPlanRoutes(app: FastifyInstance, continuationAuthorized: (request: FastifyRequest) => Promise<boolean>): void {
  type Pending = { id: string; cancel: () => void; result: ChatGPTAuthorizationResult | null;
    remote?: { attempt: ChatGPTAuthorizationAttempt; signal: AbortSignal; claimed: boolean;
      reconnect?: { id: string; authorityRevision: number } } };
  const pending = new Map<string, Pending>();
  app.addHook("onClose", () => { for (const entry of pending.values()) entry.cancel(); pending.clear(); return Promise.resolve(); });
  async function admit(request: FastifyRequest, allowDisabled = false): Promise<string> {
    if (!request.sessionUserId) throw new Error("authentication_required");
    if (!(await getUserCapabilities(request.sessionUserId)).includes("use_personal_provider_credentials")) throw new Error("personal_credentials_forbidden");
    if (!allowDisabled && !(await getServerProviderPolicy(getServerDirectDb())).allowPersonalProviderKeys) throw new Error("personal_credentials_disabled");
    return request.sessionUserId;
  }
  const safe = (error: unknown) => ({ error: error instanceof ChatGPTPlanError ? error.code
    : error instanceof Error && ["authentication_required", "personal_credentials_forbidden", "personal_credentials_disabled"].includes(error.message)
      ? error.message : "provider_unavailable" });
  // No request/response logging: even an authorization URL is ceremony state.
  const routeOptions = { logLevel: "silent" as const };
  app.get("/api/account/chatgpt", routeOptions, async (request, reply) => {
    try {
      const userId = await admit(request, true);
      const db = getServerDirectDb(); const rows = await listChatGPTRegistrations(db, userId);
      const custody = rows.length ? await readPersonalProviderCustody().catch(() => null) : null;
      const runtime = await getChatGPTRuntimeIdentity(db);
      return { canEnroll: localEnrollment(request), canEnrollWithDesktop: !isCloudMode(), enabled: (await getServerProviderPolicy(db)).allowPersonalProviderKeys,
        accounts: rows.map(row => {
          let email: string | undefined; let readable = false; let pendingRegistration = false;
          try { if (custody) { const registration = readChatGPTRegistration(custody, row);
            if ("subject" in registration) email = registration.email; else pendingRegistration = true;
            readable = true; } } catch { /* Public status remains repairable. */ }
          return { id: row.id, label: email ?? "ChatGPT account", registrationLabel: row.id.slice(0, 8),
            revision: row.authorityRevision, selected: row.selected, pendingRegistration, requiresReplacement: row.serverInstanceId !== runtime || !readable,
            state: row.state === "disconnected" ? row.state : row.serverInstanceId !== runtime || !readable ? "reconnect_required" : row.state };
        }) };
    } catch (error) { return sendError(reply, 403, safe(error)); }
  });
  app.post("/api/account/chatgpt/sign-in", routeOptions, async (request, reply) => {
    try {
      const userId = await admit(request);
      const body = request.body;
      const desktopPort = object(body) ? body["desktopPort"] : undefined;
      if (isCloudMode() || (!localEnrollment(request) && desktopPort === undefined)) return sendError(reply, 409, { error: "local_enrollment_required" });
      if (!object(body) || Object.keys(body).some(key => key !== "accountId" && key !== "desktopPort")
        || (desktopPort !== undefined && (!Number.isInteger(desktopPort) || (desktopPort as number) < 1 || (desktopPort as number) > 65535))
        || (body["accountId"] !== undefined && (typeof body["accountId"] !== "string" || !UUID.test(body["accountId"])))) {
        return sendError(reply, 400, { error: "authorization_invalid" });
      }
      const db = getServerDirectDb();
      const row = typeof body["accountId"] === "string" ? await getChatGPTRegistration(db, userId, body["accountId"]) : null;
      if (body["accountId"] && !row) return sendError(reply, 404, { error: "credential_unavailable" });
      const registration = row ? readChatGPTRegistration(await readPersonalProviderCustody(), row) : undefined;
      pending.get(userId)?.cancel();
      const entry: Pending = { id: randomUUID(), cancel: () => {}, result: null };
      // Reserve before the first await so a second browser tab can supersede it.
      pending.set(userId, entry);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SIGN_IN_TIMEOUT_MS); timer.unref();
      entry.cancel = () => controller.abort();
      if (typeof desktopPort === "number") {
        try {
          const authorization = createChatGPTAuthorization({ hostId: `urn:uuid:${await getChatGPTRuntimeIdentity(db)}`,
            port: desktopPort, ...(registration ? { registration } : {}) });
          controller.signal.throwIfAborted();
          if (pending.get(userId) !== entry) throw new ChatGPTPlanError("authorization_expired");
          entry.remote = { attempt: authorization.attempt, signal: controller.signal, claimed: false,
            ...(row ? { reconnect: { id: row.id, authorityRevision: row.authorityRevision } } : {}) };
          entry.cancel = () => { clearTimeout(timer); controller.abort(); };
          controller.signal.addEventListener("abort", () => { if (pending.get(userId) === entry) pending.delete(userId); }, { once: true });
          return { attemptId: entry.id, authorizationUrl: authorization.url };
        } catch (error) {
          clearTimeout(timer); controller.abort();
          if (pending.get(userId) === entry) pending.delete(userId);
          throw error;
        }
      }
      let reconnect = row ? { id: row.id, authorityRevision: row.authorityRevision } : undefined;
      let flow: Awaited<ReturnType<typeof startChatGPTLoopback>>;
      try {
        flow = await startChatGPTLoopback({ hostId: `urn:uuid:${await getChatGPTRuntimeIdentity(db)}`,
          ...(registration ? { registration } : {}), signal: controller.signal,
          issued: async (clientId, signal) => {
            if (reconnect) return;
            if (!await continuationAuthorized(request)) throw new ChatGPTPlanError("authorization_expired");
            await admit(request);
            if (pending.get(userId) !== entry) throw new ChatGPTPlanError("authorization_expired");
            reconnect = await chatGPTSessionStore.rememberRegistration(userId, { issuer: CHATGPT_ISSUER, clientId,
              hostId: `urn:uuid:${await getChatGPTRuntimeIdentity(db)}`, pending: true }, signal);
          },
          complete: async (session, signal) => {
            if (!await continuationAuthorized(request)) throw new ChatGPTPlanError("authorization_expired");
            await admit(request);
            if (pending.get(userId) !== entry) throw new ChatGPTPlanError("authorization_expired");
            await chatGPTSessionStore.connect(userId, session, signal,
              reconnect);
          },
        });
      } catch (error) { clearTimeout(timer); if (pending.get(userId) === entry) pending.delete(userId); throw error; }
      void flow.result.then(result => {
        clearTimeout(timer); entry.result = result;
        // Keep the result for a bounded polling window, including abandoned tabs.
        const cleanup = setTimeout(() => { if (pending.get(userId) === entry) pending.delete(userId); }, SIGN_IN_TIMEOUT_MS);
        cleanup.unref();
        entry.cancel = () => clearTimeout(cleanup);
      });
      return { attemptId: entry.id, authorizationUrl: flow.url };
    } catch (error) { return sendError(reply, 400, safe(error)); }
  });
  app.post("/api/account/chatgpt/sign-in/:id/complete", routeOptions, async (request, reply) => {
    try {
      const userId = await admit(request);
      if (isCloudMode()) return sendError(reply, 409, { error: "local_enrollment_required" });
      const entry = pending.get(userId);
      const remote = entry?.remote;
      if (!entry || entry.id !== (request.params as { id: string }).id || !remote || remote.claimed || remote.signal.aborted) {
        return sendError(reply, 409, { error: "authorization_expired" });
      }
      const body = request.body;
      if (!object(body) || Object.keys(body).length !== 1 || typeof body["callbackUrl"] !== "string") {
        return sendError(reply, 400, { error: "authorization_invalid" });
      }
      // Claim synchronously before exchange: neither concurrent completion nor
      // a retry after an ambiguous exchange may reuse this authorization code.
      remote.claimed = true;
      try {
        const callback = new URL(body["callbackUrl"]);
        const { clientId } = parseChatGPTCallback(remote.attempt, callback);
        if (!await continuationAuthorized(request)) throw new ChatGPTPlanError("authorization_expired");
        await admit(request);
        if (pending.get(userId) !== entry) throw new ChatGPTPlanError("authorization_expired");
        if (!remote.reconnect) remote.reconnect = await chatGPTSessionStore.rememberRegistration(userId,
          { issuer: CHATGPT_ISSUER, clientId, hostId: remote.attempt.hostId, pending: true }, remote.signal);
        remote.signal.throwIfAborted();
        const session = await new ChatGPTOAuth().exchange(remote.attempt, callback, remote.signal);
        if (!await continuationAuthorized(request)) throw new ChatGPTPlanError("authorization_expired");
        await admit(request);
        if (pending.get(userId) !== entry) throw new ChatGPTPlanError("authorization_expired");
        await chatGPTSessionStore.connect(userId, session, remote.signal, remote.reconnect);
        entry.result = { status: "connected" };
      } catch (error) {
        entry.result = { status: "failed", code: error instanceof ChatGPTPlanError ? error.code : "provider_unavailable" };
      }
      return entry.result;
    } catch (error) { return sendError(reply, 400, safe(error)); }
  });
  app.get("/api/account/chatgpt/sign-in/:id", routeOptions, async (request, reply) => {
    try {
      const userId = await admit(request, true); const id = (request.params as { id: string }).id;
      const entry = pending.get(userId);
      if (!entry || entry.id !== id) return sendError(reply, 404, { error: "authorization_expired" });
      return entry.result ?? { status: "pending" as const };
    } catch (error) { return sendError(reply, 403, safe(error)); }
  });
  app.delete("/api/account/chatgpt/sign-in/:id", routeOptions, async (request, reply) => {
    try {
      const userId = await admit(request, true); const entry = pending.get(userId);
      if (entry?.id === (request.params as { id: string }).id) { entry.cancel(); pending.delete(userId); }
      return { ok: true };
    } catch (error) { return sendError(reply, 403, safe(error)); }
  });
  app.put("/api/account/chatgpt/selection", routeOptions, async (request, reply) => {
    try {
      const userId = await admit(request); const body = request.body;
      if (!object(body) || Object.keys(body).length !== 1
        || !(body["accountId"] === null || typeof body["accountId"] === "string" && UUID.test(body["accountId"]))) {
        return sendError(reply, 400, { error: "authorization_invalid" });
      }
      const ok = await selectChatGPTRegistration(getServerDirectDb(), userId, body["accountId"]);
      if (!ok) return sendError(reply, 409, { error: "credential_unavailable" });
      return { ok };
    } catch (error) { return sendError(reply, 403, safe(error)); }
  });
  app.get("/api/account/chatgpt/:id/models", routeOptions, async (request, reply) => {
    try {
      const userId = await admit(request); const id = (request.params as { id: string }).id;
      if (!UUID.test(id)) return sendError(reply, 400, { error: "authorization_invalid" });
      const row = await getChatGPTRegistration(getServerDirectDb(), userId, id);
      if (!row) return sendError(reply, 404, { error: "credential_unavailable" });
      return { models: await listChatGPTModels(row, AbortSignal.timeout(DEFAULT_PROVIDER_TIMEOUT_MS)) };
    } catch (error) { return sendError(reply, 400, safe(error)); }
  });
  app.post("/api/account/chatgpt/:id/disconnect", routeOptions, async (request, reply) => {
    try {
      const userId = await admit(request, true); const id = (request.params as { id: string }).id;
      const body = request.body;
      if (!UUID.test(id) || !object(body) || Object.keys(body).length !== 1 || !Number.isSafeInteger(body["revision"]) || (body["revision"] as number) < 1) {
        return sendError(reply, 400, { error: "authorization_invalid" });
      }
      pending.get(userId)?.cancel(); pending.delete(userId);
      return await chatGPTSessionStore.disconnect(userId, id, body["revision"] as number, AbortSignal.timeout(DEFAULT_PROVIDER_TIMEOUT_MS));
    } catch (error) { return sendError(reply, 400, safe(error)); }
  });
}
