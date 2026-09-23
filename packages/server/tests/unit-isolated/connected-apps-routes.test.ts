import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { connectedAppsRoutes } from "../../src/routes/connected-apps";
import type { ConnectedAppService } from "../../src/connected-apps/service";
import type { ConnectedAppResultPresenter } from "../../src/connected-apps/result-presentation";
import { ServerProviderCredentialsDeniedError } from "@nautilo/trust";

const apps: FastifyInstance[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

function fixture(input: {
  authenticated?: boolean;
  canManage?: boolean;
  resultPresenter?: ConnectedAppResultPresenter;
} = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  apps.push(app);
  if (input.authenticated) {
    app.addHook("onRequest", async (request) => {
      request.sessionUserId = "11111111-1111-4111-8111-111111111111";
      request.memoryEnvelope = {
        roomId: "77777777-7777-4777-8777-777777777777",
        writableNamespaces: ["22222222-2222-4222-8222-222222222222"],
      } as never;
    });
  }
  connectedAppsRoutes(app, {
    providerId: "notion",
    list: async () => [],
    getProviderSetup: async () => ({
      providerId: "notion",
      driverKind: "openconnector_local",
      status: "setup_required",
      callbackUrl: "http://127.0.0.1:3000/oauth/callback",
      oauthScopes: ["pages:read", "pages:write"],
      clientId: null,
      adminAuthenticationConfigured: false,
      lastErrorCode: null,
      lastVerifiedAt: null,
    }),
    startOauth: async () => { throw new Error("not called"); },
    inspectAttempt: async () => { throw new Error("not called"); },
    cancelAttempt: async () => ({
      status: "failed",
      providerId: "notion",
      account: null,
      errorCode: "authorization_restarted",
    }),
  } as unknown as ConnectedAppService, {
    getCapabilities: async () => input.canManage ? ["manage_connection_providers"] : [],
    ...(input.resultPresenter ? { resultPresenter: input.resultPresenter } : {}),
  });
  return app;
}

describe("D456 connected-app routes", () => {
  test("hosted OAuth start and inspection stop before provider calls when server funding is denied", async () => {
    const app = Fastify({ logger: false });
    apps.push(app);
    app.addHook("onRequest", async (request) => {
      request.sessionUserId = "11111111-1111-4111-8111-111111111111";
      request.memoryEnvelope = {
        roomId: "77777777-7777-4777-8777-777777777777",
        writableNamespaces: ["22222222-2222-4222-8222-222222222222"],
      } as never;
    });
    const startOauth = mock(async () => { throw new Error("hosted provider reached"); });
    const inspectAttempt = mock(async () => { throw new Error("hosted provider reached"); });
    const assertServerFunding = mock(async (humanUserId: string): Promise<void> => {
      throw new ServerProviderCredentialsDeniedError(humanUserId);
    });
    connectedAppsRoutes(app, {
      providerId: "notion",
      usesHostedDriver: true,
      startOauth,
      inspectAttempt,
    } as unknown as ConnectedAppService, { assertServerFunding });
    const start = await app.inject({ method: "POST", url: "/api/connected-apps/notion/oauth" });
    const inspect = await app.inject({ method: "GET", url: "/api/connected-apps/notion/oauth/33333333-3333-4333-8333-333333333333" });
    expect(start.statusCode).toBe(403);
    expect(inspect.statusCode).toBe(403);
    expect(JSON.parse(start.body)).toEqual({ error: "server_provider_credentials_required" });
    expect(JSON.parse(inspect.body)).toEqual({ error: "server_provider_credentials_required" });
    expect(assertServerFunding).toHaveBeenCalledTimes(2);
    expect(startOauth).not.toHaveBeenCalled();
    expect(inspectAttempt).not.toHaveBeenCalled();
  });

  test("returns a secret-free public browser completion page", async () => {
    const response = await fixture().inject({
      method: "GET",
      url: "/connections/oauth/complete?code=PLANTED_CODE&providerConfigId=PLANTED_CONFIG",
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toContain("Return to Nautilo");
    expect(response.body).not.toContain("PLANTED_CODE");
    expect(response.body).not.toContain("PLANTED_CONFIG");
  });

  test("keeps status and OAuth attempt APIs authenticated", async () => {
    const list = await fixture().inject({ method: "GET", url: "/api/connected-apps" });
    expect(list.statusCode).toBe(401);
    expect(list.body).toBe('{"error":"authentication_required"}');

    const cancelled = await fixture().inject({
      method: "DELETE",
      url: "/api/connected-apps/notion/oauth/33333333-3333-4333-8333-333333333333",
    });
    expect(cancelled.statusCode).toBe(401);

    const preview = await fixture().inject({
      method: "GET",
      url: "/api/connected-apps/result-media?ref=opaque_preview_A&roomId=77777777-7777-4777-8777-777777777777",
    });
    expect(preview.statusCode).toBe(401);
  });

  test("serves preview bytes only through the authenticated exact-scope media route", async () => {
    const readPreview = mock(async () => ({
      chunks: (async function* () { yield new Uint8Array([1, 2, 3]); })(),
      contentType: "image/png",
    }));
    const opaqueRef = "A".repeat(1_500);
    const response = await fixture({
      authenticated: true,
      resultPresenter: { readPreview } as unknown as ConnectedAppResultPresenter,
    }).inject({
      method: "GET",
      url: `/api/connected-apps/result-media?ref=${opaqueRef}&roomId=77777777-7777-4777-8777-777777777777`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/png");
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect([...response.rawPayload]).toEqual([1, 2, 3]);
    expect(readPreview).toHaveBeenCalledWith({
      scope: {
        userId: "11111111-1111-4111-8111-111111111111",
        namespaceId: "22222222-2222-4222-8222-222222222222",
      },
      ref: opaqueRef,
    });
  });

  test("lets the owning Human terminate an OAuth attempt immediately", async () => {
    const response = await fixture({ authenticated: true }).inject({
      method: "DELETE",
      url: "/api/connected-apps/notion/oauth/33333333-3333-4333-8333-333333333333",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{
      status: string;
      providerId: string;
      account: null;
      errorCode: string;
    }>()).toEqual({
      status: "failed",
      providerId: "notion",
      account: null,
      errorCode: "authorization_restarted",
    });
  });

  test("returns the exact Room that owns the listed connection scope", async () => {
    const response = await fixture({ authenticated: true }).inject({
      method: "GET",
      url: "/api/connected-apps",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{
      status: "ok";
      scopeRoomId: string;
      apps: unknown[];
    }>()).toEqual({
      status: "ok",
      scopeRoomId: "77777777-7777-4777-8777-777777777777",
      apps: [],
    });
  });

  test("shows exact setup only to connection-provider administrators", async () => {
    const ordinary = await fixture({ authenticated: true }).inject({
      method: "GET",
      url: "/api/connected-apps/notion/setup",
    });
    expect(ordinary.statusCode).toBe(403);
    expect(ordinary.json<{ error: string }>()).toEqual({ error: "connected_app_setup_forbidden" });

    const admin = await fixture({ authenticated: true, canManage: true }).inject({
      method: "GET",
      url: "/api/connected-apps/notion/setup",
    });
    expect(admin.statusCode).toBe(200);
    expect(admin.json()).toMatchObject({
      callbackUrl: "http://127.0.0.1:3000/oauth/callback",
      oauthScopes: ["pages:read", "pages:write"],
      clientId: null,
    });
  });
});
