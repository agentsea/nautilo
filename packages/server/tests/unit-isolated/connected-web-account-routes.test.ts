import { expect, test } from "bun:test";
import Fastify from "fastify";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  connectedWebAccountDisconnectResponseSchema,
  connectedWebAccountListResponseSchema,
  connectedWebAccountLoginResponseSchema,
  connectedWebAccountClosePageResponseSchema,
  connectedWebAccountReadActivitySchema,
  connectedWebAccountReadWatchSchema,
  connectedWebAccountCancelReadResponseSchema,
  connectedWebAccountActionActivitySchema,
  connectedWebAccountStopActionResponseSchema,
  connectedWebAccountActionWatchSchema,
  type ConnectedWebAccount,
  type ConnectedWebAccountProviderSetupStatus,
} from "@nautilo/types";
import {
  connectedWebAccountRoutes,
  type ConnectedWebAccountRoutesController,
} from "../../src/routes/connected-web-accounts";
import {
  ConnectedWebAccountStoreError,
  activeExecutionCheckpointExpression,
  canAcquireExecutionCheckpoint,
  executionSourceStatusForCheckpoint,
  executionStatusForCheckpoint,
} from "../../src/connected-web-accounts/store";
import { ConnectedWebAccountControllerError } from "../../src/connected-web-accounts/controller";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ACCOUNT = "33333333-3333-4333-8333-333333333333";
const account: ConnectedWebAccount = {
  id: ACCOUNT,
  service: "Example",
  origin: "https://example.test",
  label: "Example account",
  status: "connected",
  lastVerifiedAt: null,
  createdAt: "2026-09-01T12:00:00.000Z",
  updatedAt: "2026-09-01T12:00:00.000Z",
};

function controller(providerSetupStatus: ConnectedWebAccountProviderSetupStatus = "ready"): ConnectedWebAccountRoutesController {
  let current: ConnectedWebAccount | null = account;
  function owned(ownerUserId: string, accountId: string): ConnectedWebAccount {
    if (ownerUserId !== OWNER || accountId !== ACCOUNT || current === null) throw new ConnectedWebAccountStoreError("not_found");
    return current;
  }
  return {
    providerSetupStatus() { return providerSetupStatus; },
    async create({ ownerUserId, account: input }) {
      if (ownerUserId !== OWNER) throw new ConnectedWebAccountStoreError("not_found");
      const { createAnother: _createAnother, ...metadata } = input;
      current = { ...account, ...metadata, status: "connecting" };
      return { account: current, login: { liveViewUrl: "https://live.example.test/session", expiresAt: "2026-09-01T16:00:00.000Z" }, createdNewAccount: true };
    },
    async list(ownerUserId) { return ownerUserId === OWNER && current ? [current] : []; },
    async get({ ownerUserId, accountId }) { return ownerUserId === OWNER && accountId === ACCOUNT ? current : null; },
    async finish({ ownerUserId, accountId }) { current = { ...owned(ownerUserId, accountId), status: "connected" }; return current; },
    async reconnect({ ownerUserId, accountId }) { current = { ...owned(ownerUserId, accountId), status: "connecting" }; return { account: current, login: { liveViewUrl: "https://live.example.test/session", expiresAt: "2026-09-01T16:00:00.000Z" }, createdNewAccount: false }; },
    async openPage({ ownerUserId, accountId }) { current = { ...owned(ownerUserId, accountId), status: "busy" }; return { account: current, login: { liveViewUrl: "https://live.example.test/session", expiresAt: "2026-09-01T16:00:00.000Z" }, createdNewAccount: false }; },
    async closePage({ ownerUserId, accountId }) { current = { ...owned(ownerUserId, accountId), status: "connected" }; return current; },
    async cancelLogin({ ownerUserId, accountId }) { current = { ...owned(ownerUserId, accountId), status: "attention_needed" }; return current; },
    async readActivity({ ownerUserId, accountId }) { owned(ownerUserId, accountId); return { accountId, stage: "browsing", canWatch: true }; },
    async watchRead({ ownerUserId, accountId }) { owned(ownerUserId, accountId); return { liveViewUrl: "https://live.browser-use.com/?opaque" }; },
    async cancelRead({ ownerUserId, accountId }) { current = { ...owned(ownerUserId, accountId), status: "connected" }; return current; },
    async actionActivity({ ownerUserId, deliveryId }) { owned(ownerUserId, ACCOUNT); if (deliveryId !== "tool-call") throw new ConnectedWebAccountStoreError("not_found"); return { deliveryId, accountId: ACCOUNT, action: "save_item" as const, stage: "browsing" as const, canWatch: true, canStop: true, terminal: null }; },
    async watchAction({ ownerUserId, deliveryId }) { owned(ownerUserId, ACCOUNT); if (deliveryId !== "tool-call") throw new ConnectedWebAccountStoreError("not_found"); return { liveViewUrl: "https://live.browser-use.com/?opaque" }; },
    async stopAction({ ownerUserId, deliveryId }) { owned(ownerUserId, ACCOUNT); if (deliveryId !== "tool-call") throw new ConnectedWebAccountStoreError("not_found"); return { deliveryId, accountId: ACCOUNT, action: "save_item" as const, stage: "finishing" as const, canWatch: false, canStop: false, terminal: "ambiguous" as const }; },
    async disconnect({ ownerUserId, accountId }) { current = { ...owned(ownerUserId, accountId), status: "revoked" }; return current; },
  };
}

async function makeApp(
  providerSetupStatus: ConnectedWebAccountProviderSetupStatus = "ready",
  controllerOverride?: ConnectedWebAccountRoutesController,
) {
  const app = Fastify();
  app.addHook("onRequest", (request, _reply, done) => {
    const bearer = request.headers.authorization;
    (request as unknown as { sessionUserId: string | null }).sessionUserId = bearer === "owner" || bearer === "guest" ? OWNER : bearer === "other" ? OTHER : null;
    (request as unknown as { policyContext: { actorRole: string } }).policyContext = { actorRole: bearer === "guest" ? "guest" : "member" };
    done();
  });
  connectedWebAccountRoutes(app, { controller: controllerOverride ?? controller(providerSetupStatus) });
  await app.ready();
  return app;
}

test("D568 routes scope every account lookup and lifecycle command to the authenticated Human", async () => {
  const app = await makeApp();
  try {
    expect((await app.inject({ method: "GET", url: "/api/connected-web-accounts" })).statusCode).toBe(401);
    const otherList = await app.inject({ method: "GET", url: "/api/connected-web-accounts", headers: { authorization: "other" } });
    expect(connectedWebAccountListResponseSchema.parse(JSON.parse(otherList.body))).toEqual({ accounts: [], providerSetupStatus: "ready" });
    expect((await app.inject({ method: "GET", url: `/api/connected-web-accounts/${ACCOUNT}`, headers: { authorization: "other" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/api/connected-web-accounts/${ACCOUNT}/reconnect`, headers: { authorization: "other" }, payload: {} })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/api/connected-web-accounts/${ACCOUNT}/open-page`, headers: { authorization: "other" }, payload: {} })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/api/connected-web-accounts/${ACCOUNT}/close-page`, headers: { authorization: "other" }, payload: {} })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/connected-web-accounts/${ACCOUNT}/read-activity`, headers: { authorization: "other" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/api/connected-web-accounts/${ACCOUNT}/watch-read`, headers: { authorization: "other" }, payload: {} })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/api/connected-web-accounts/${ACCOUNT}/cancel-read`, headers: { authorization: "other" }, payload: {} })).statusCode).toBe(404);
    const listed = await app.inject({ method: "GET", url: "/api/connected-web-accounts", headers: { authorization: "owner" } });
    expect(listed.statusCode).toBe(200);
    expect(connectedWebAccountListResponseSchema.parse(JSON.parse(listed.body))).toMatchObject({ accounts: [account], providerSetupStatus: "ready" });
    expect((await app.inject({ method: "GET", url: "/api/connected-web-accounts", headers: { authorization: "guest" } })).statusCode).toBe(403);
  } finally { await app.close(); }
});

test("D568 exposes safe Browser Use setup readiness to every authenticated owner and blocks dead-end launches", async () => {
  const app = await makeApp("api_key_required");
  try {
    const listed = await app.inject({ method: "GET", url: "/api/connected-web-accounts", headers: { authorization: "owner" } });
    expect(connectedWebAccountListResponseSchema.parse(JSON.parse(listed.body)).providerSetupStatus).toBe("api_key_required");

    const launched = await app.inject({
      method: "POST",
      url: "/api/connected-web-accounts",
      headers: { authorization: "owner" },
      payload: { service: "Example", origin: "https://example.test", label: "Example", createAnother: false },
    });
    expect(launched.statusCode).toBe(503);
    expect(JSON.parse(launched.body)).toEqual({ error: "browser_use_api_key_required" });
    expect(launched.body).not.toContain("keyValue");
  } finally { await app.close(); }
});

test("D568 returns a specific retryable conflict when Done finds authentication incomplete", async () => {
  const routeController = controller();
  routeController.finish = async () => {
    throw new ConnectedWebAccountControllerError("authentication_incomplete");
  };
  const app = await makeApp("ready", routeController);
  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/connected-web-accounts/${ACCOUNT}/finish`,
      headers: { authorization: "owner" },
      payload: {},
    });
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body)).toEqual({ error: "connected_web_account_authentication_incomplete" });
  } finally { await app.close(); }
});

test("D568 exposes active-read activity, live watch, and stop only through owner routes", async () => {
  const app = await makeApp();
  try {
    const activity = await app.inject({ method: "GET", url: `/api/connected-web-accounts/${ACCOUNT}/read-activity`, headers: { authorization: "owner" } });
    expect(connectedWebAccountReadActivitySchema.parse(JSON.parse(activity.body))).toEqual({ accountId: ACCOUNT, stage: "browsing", canWatch: true });
    expect(activity.body).not.toContain("runId");

    const watch = await app.inject({ method: "POST", url: `/api/connected-web-accounts/${ACCOUNT}/watch-read`, headers: { authorization: "owner" }, payload: {} });
    expect(connectedWebAccountReadWatchSchema.parse(JSON.parse(watch.body)).liveViewUrl).toContain("live.browser-use.com");

    const stopped = await app.inject({ method: "POST", url: `/api/connected-web-accounts/${ACCOUNT}/cancel-read`, headers: { authorization: "owner" }, payload: {} });
    expect(connectedWebAccountCancelReadResponseSchema.parse(JSON.parse(stopped.body)).account.status).toBe("connected");
  } finally { await app.close(); }
});

test("D568 action controls use the exact authenticated delivery identity", async () => {
  const app = await makeApp();
  try {
    expect((await app.inject({ method: "GET", url: "/api/connected-web-actions/tool-call/activity" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/connected-web-actions/tool-call/activity", headers: { authorization: "other" } })).statusCode).toBe(404);
    const activity = await app.inject({ method: "GET", url: "/api/connected-web-actions/tool-call/activity", headers: { authorization: "owner" } });
    expect(connectedWebAccountActionActivitySchema.parse(JSON.parse(activity.body))).toMatchObject({ deliveryId: "tool-call", accountId: ACCOUNT, canStop: true });
    const watch = await app.inject({ method: "POST", url: "/api/connected-web-actions/tool-call/watch", headers: { authorization: "owner" }, payload: {} });
    expect(connectedWebAccountActionWatchSchema.parse(JSON.parse(watch.body)).liveViewUrl).toContain("live.browser-use.com");
    const stop = await app.inject({ method: "POST", url: "/api/connected-web-actions/tool-call/stop", headers: { authorization: "owner" }, payload: {} });
    expect(connectedWebAccountStopActionResponseSchema.parse(JSON.parse(stop.body)).activity.terminal).toBe("ambiguous");
    expect((await app.inject({ method: "POST", url: "/api/connected-web-actions/tool-call/watch", headers: { authorization: "owner" }, payload: { runId: "provider-run" } })).statusCode).toBe(400);
  } finally { await app.close(); }
});

test("D568 open-page returns only the existing owner-gated login response and close-page returns connected", async () => {
  const app = await makeApp();
  try {
    const opened = await app.inject({
      method: "POST",
      url: `/api/connected-web-accounts/${ACCOUNT}/open-page`,
      headers: { authorization: "owner" },
      payload: {},
    });
    expect(opened.statusCode).toBe(200);
    const body = connectedWebAccountLoginResponseSchema.parse(JSON.parse(opened.body));
    expect(body.account.status).toBe("busy");
    expect(body.createdNewAccount).toBe(false);
    for (const forbidden of ["profileRef", "browserId", "runId", "cdpUrl", "executionCheckpoint"]) {
      expect(opened.body).not.toContain(forbidden);
    }
    const closed = await app.inject({
      method: "POST",
      url: `/api/connected-web-accounts/${ACCOUNT}/close-page`,
      headers: { authorization: "owner" },
      payload: {},
    });
    expect(closed.statusCode).toBe(200);
    expect(connectedWebAccountClosePageResponseSchema.parse(JSON.parse(closed.body)).account.status).toBe("connected");
  } finally { await app.close(); }
});

test("D568 route payloads and projections cannot carry profile, browser, run, or live-view identifiers", async () => {
  const app = await makeApp();
  try {
    const invalid = await app.inject({
      method: "POST",
      url: "/api/connected-web-accounts",
      headers: { authorization: "owner" },
      payload: { service: "Example", origin: "https://example.test", label: "Example", profileRef: "provider-profile" },
    });
    expect(invalid.statusCode).toBe(400);
    const disconnected = await app.inject({ method: "DELETE", url: `/api/connected-web-accounts/${ACCOUNT}`, headers: { authorization: "owner" } });
    expect(disconnected.statusCode).toBe(200);
    for (const forbidden of ["profileRef", "browserId", "runId", "liveViewUrl", "cdpUrl", "executionCheckpoint"]) {
      expect(disconnected.body).not.toContain(forbidden);
    }
    expect(connectedWebAccountDisconnectResponseSchema.parse(JSON.parse(disconnected.body)).websiteSessionWarning).toContain("sign out other sessions");
  } finally { await app.close(); }
});

test("D568 classifies a login checkpoint as connecting and reads/private page views as busy", () => {
  expect(executionStatusForCheckpoint({ resource: "login", phase: "active", reservationToken: "login-token", opaqueExecutionRef: "login-ref", recordedAt: "2026-09-01T12:00:00.000Z" })).toBe("connecting");
  expect(executionStatusForCheckpoint({ resource: "read", phase: "active", reservationToken: "read-token", opaqueExecutionRef: "read-ref", recordedAt: "2026-09-01T12:00:00.000Z" })).toBe("busy");
  expect(executionStatusForCheckpoint({ resource: "view", phase: "active", reservationToken: "view-token", opaqueExecutionRef: "view-ref", recordedAt: "2026-09-01T12:00:00.000Z" })).toBe("busy");
  expect(executionSourceStatusForCheckpoint({ resource: "read", phase: "active", reservationToken: "read-token", opaqueExecutionRef: "read-ref", recordedAt: "2026-09-01T12:00:00.000Z" })).toBe("connected");
  expect(executionSourceStatusForCheckpoint({ resource: "view", phase: "active", reservationToken: "view-token", opaqueExecutionRef: "view-ref", recordedAt: "2026-09-01T12:00:00.000Z" })).toBe("connected");
});

test("D568 admits exactly one checkpoint only from its lifecycle source state", () => {
  const login = { resource: "login", phase: "reserving", reservationToken: "login-token", recordedAt: "2026-09-01T12:00:00.000Z" } as const;
  const read = { resource: "read", phase: "reserving", reservationToken: "read-token", recordedAt: "2026-09-01T12:00:00.000Z" } as const;
  const view = { resource: "view", phase: "reserving", reservationToken: "view-token", recordedAt: "2026-09-01T12:00:00.000Z" } as const;
  expect(canAcquireExecutionCheckpoint({ status: "connecting", profileRef: "profile", executionCheckpoint: null, checkpoint: login })).toBe(true);
  expect(canAcquireExecutionCheckpoint({ status: "connected", profileRef: "profile", executionCheckpoint: null, checkpoint: read })).toBe(true);
  expect(canAcquireExecutionCheckpoint({ status: "connected", profileRef: "profile", executionCheckpoint: null, checkpoint: view })).toBe(true);
  expect(canAcquireExecutionCheckpoint({ status: "busy", profileRef: "profile", executionCheckpoint: null, checkpoint: read })).toBe(false);
  expect(canAcquireExecutionCheckpoint({ status: "connected", profileRef: "profile", executionCheckpoint: login, checkpoint: read })).toBe(false);
  expect(canAcquireExecutionCheckpoint({ status: "attention_needed", profileRef: "profile", executionCheckpoint: null, checkpoint: read })).toBe(false);
});

test("D568 types the provider execution reference before PostgreSQL builds the active checkpoint", () => {
  const query = new PgDialect().sqlToQuery(activeExecutionCheckpointExpression("browser-ref"));
  expect(query.sql).toContain("jsonb_build_object('opaqueExecutionRef', $1::text)");
  expect(query.params).toEqual(["browser-ref"]);
});
