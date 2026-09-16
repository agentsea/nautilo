import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import {
  integrationsGoogleRoutes,
  type IntegrationsGoogleRouteDeps,
} from "../../src/routes/integrations-google";
import { validateGoogleOAuthClientJson } from "../../src/lib/google-oauth-client-store";

const USER_SIGNED_IN = "user-signed-in";
const USER_WORKSPACE = "user-workspace";
const USER_OWNER = "user-owner";

const VALID_INSTALLED = JSON.stringify({
  installed: {
    client_id: "222222222222-route.apps.googleusercontent.com",
    client_secret: "GOCSPX-route-secret",
  },
});

let storedJson: string | null = null;
const apps: FastifyInstance[] = [];
const auditEvents: unknown[] = [];

function makeStoreDeps(
  getCapabilities: NonNullable<IntegrationsGoogleRouteDeps["getCapabilities"]>,
  managed = false,
): IntegrationsGoogleRouteDeps {
  return {
    getCapabilities,
    isManagedDeployment: () => managed,
    auditEvent: async (event) => { auditEvents.push(event); },
    getGoogleOAuthClient: () => storedJson,
    googleOAuthClientStatus: () => {
      if (!storedJson) return { configured: false, clientId: null };
      const validation = validateGoogleOAuthClientJson(storedJson);
      if (!validation.ok) return { configured: false, clientId: null };
      return { configured: true, clientId: validation.maskedClientId };
    },
    setGoogleOAuthClient: async (json: string) => {
      const validation = validateGoogleOAuthClientJson(json);
      if (!validation.ok) return { configured: false, detail: validation.detail };
      storedJson = json;
      return { configured: true, clientId: validation.maskedClientId };
    },
    clearGoogleOAuthClient: async () => {
      storedJson = null;
      return true;
    },
  };
}

function installSessionPreHandler(instance: FastifyInstance): void {
  instance.decorateRequest("sessionUserId", null);
  instance.addHook("preHandler", (request, _reply, done) => {
    const header = request.headers["x-test-user-id"];
    request.sessionUserId = typeof header === "string" ? header : null;
    done();
  });
}

async function makeApp(
  getCapabilities: NonNullable<IntegrationsGoogleRouteDeps["getCapabilities"]>,
  options: { managed?: boolean } = {},
) {
  const app = Fastify({ logger: false });
  installSessionPreHandler(app);
  await app.register(multipart);
  integrationsGoogleRoutes(
    app,
    makeStoreDeps(getCapabilities, options.managed ?? false),
  );
  await app.ready();
  apps.push(app);
  return app;
}

beforeEach(() => {
  storedJson = null;
  auditEvents.length = 0;
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function capsFor(userId: string): Promise<string[]> {
  if (userId === USER_OWNER) return ["manage_connection_providers", "use_google_workspace"];
  if (userId === USER_WORKSPACE) return ["use_google_workspace"];
  if (userId === USER_SIGNED_IN) return ["read_server_settings"];
  return [];
}

describe("integrations google routes", () => {
  test("status returns 401 when unsigned", async () => {
    const app = await makeApp(capsFor);
    const res = await app.inject({ method: "GET", url: "/api/integrations/google/status" });
    expect(res.statusCode).toBe(401);
  });

  test("status reports readiness without leaking provider identity to an ordinary user", async () => {
    storedJson = VALID_INSTALLED;
    const app = await makeApp(capsFor);
    const res = await app.inject({
      method: "GET",
      url: "/api/integrations/google/status",
      headers: { "x-test-user-id": USER_SIGNED_IN },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      configured: true,
      providerSetupStatus: "ready",
      canManageProviderSetup: false,
    });
  });

  test("status exposes masked provider identity only to a self-hosted provider administrator", async () => {
    storedJson = VALID_INSTALLED;
    const app = await makeApp(capsFor);
    const res = await app.inject({
      method: "GET",
      url: "/api/integrations/google/status",
      headers: { "x-test-user-id": USER_OWNER },
    });
    expect(JSON.parse(res.body)).toEqual({
      configured: true,
      providerSetupStatus: "ready",
      canManageProviderSetup: true,
      clientId: "222222222222…",
    });
  });

  test("managed status hides provider configuration even from an owner", async () => {
    storedJson = VALID_INSTALLED;
    const app = await makeApp(capsFor, { managed: true });
    const res = await app.inject({
      method: "GET",
      url: "/api/integrations/google/status",
      headers: { "x-test-user-id": USER_OWNER },
    });
    expect(JSON.parse(res.body)).toEqual({
      configured: true,
      providerSetupStatus: "managed",
      canManageProviderSetup: false,
    });
  });

  test("download returns 403 without use_google_workspace", async () => {
    storedJson = VALID_INSTALLED;
    const app = await makeApp(capsFor);
    const res = await app.inject({
      method: "GET",
      url: "/api/integrations/google/oauth-client",
      headers: { "x-test-user-id": USER_SIGNED_IN },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({
      error: "capability_missing",
      capability: "use_google_workspace",
    });
  });

  test("download returns 404 when not configured", async () => {
    const app = await makeApp(capsFor);
    const res = await app.inject({
      method: "GET",
      url: "/api/integrations/google/oauth-client",
      headers: { "x-test-user-id": USER_WORKSPACE },
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: "not_configured" });
  });

  test("download returns raw JSON for capable user", async () => {
    storedJson = VALID_INSTALLED;
    const app = await makeApp(capsFor);
    const res = await app.inject({
      method: "GET",
      url: "/api/integrations/google/oauth-client",
      headers: { "x-test-user-id": USER_WORKSPACE },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(JSON.parse(res.body)).toEqual(JSON.parse(VALID_INSTALLED));
  });

  test("upload returns 403 without connection-provider authority", async () => {
    const app = await makeApp(capsFor);
    const fd = new FormData();
    fd.set("file", new Blob([VALID_INSTALLED], { type: "application/json" }), "client.json");
    const res = await app.inject({
      method: "POST",
      url: "/api/integrations/google/oauth-client",
      headers: { "x-test-user-id": USER_WORKSPACE },
      payload: fd,
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({
      error: "capability_missing",
      capability: "manage_connection_providers",
    });
  });

  test("managed deployment refuses provider configuration", async () => {
    const app = await makeApp(capsFor, { managed: true });
    const fd = new FormData();
    fd.set("file", new Blob([VALID_INSTALLED], { type: "application/json" }), "client.json");
    const res = await app.inject({
      method: "POST",
      url: "/api/integrations/google/oauth-client",
      headers: { "x-test-user-id": USER_OWNER },
      payload: fd,
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: "managed_by_cloud" });
  });

  test("upload rejects invalid JSON with 400", async () => {
    const app = await makeApp(capsFor);
    const fd = new FormData();
    fd.set("file", new Blob(['{"bad":true}'], { type: "application/json" }), "client.json");
    const res = await app.inject({
      method: "POST",
      url: "/api/integrations/google/oauth-client",
      headers: { "x-test-user-id": USER_OWNER },
      payload: fd,
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: string; detail: string };
    expect(body.error).toBe("invalid_oauth_client_json");
    expect(typeof body.detail).toBe("string");
  });

  test("upload/status/download roundtrip via injected store", async () => {
    const app = await makeApp(capsFor);

    const fd = new FormData();
    fd.set("file", new Blob([VALID_INSTALLED], { type: "application/json" }), "client.json");
    const upload = await app.inject({
      method: "POST",
      url: "/api/integrations/google/oauth-client",
      headers: { "x-test-user-id": USER_OWNER },
      payload: fd,
    });
    expect(upload.statusCode).toBe(200);
    expect(JSON.parse(upload.body)).toEqual({
      configured: true,
      clientId: "222222222222…",
    });
    expect(auditEvents).toEqual([
      expect.objectContaining({
        kind: "google_oauth_client_config",
        action: "configure",
        outcome: "ok",
        clientId: "222222222222…",
      }),
    ]);
    expect(JSON.stringify(auditEvents)).not.toContain("GOCSPX-route-secret");

    const status = await app.inject({
      method: "GET",
      url: "/api/integrations/google/status",
      headers: { "x-test-user-id": USER_SIGNED_IN },
    });
    expect(JSON.parse(status.body)).toEqual({
      configured: true,
      providerSetupStatus: "ready",
      canManageProviderSetup: false,
    });

    const download = await app.inject({
      method: "GET",
      url: "/api/integrations/google/oauth-client",
      headers: { "x-test-user-id": USER_WORKSPACE },
    });
    expect(JSON.parse(download.body)).toEqual(JSON.parse(VALID_INSTALLED));
  });

  test("delete clears configuration", async () => {
    storedJson = VALID_INSTALLED;
    const app = await makeApp(capsFor);
    const res = await app.inject({
      method: "DELETE",
      url: "/api/integrations/google/oauth-client",
      headers: { "x-test-user-id": USER_OWNER },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ configured: false });
    expect(storedJson).toBeNull();
    expect(auditEvents).toEqual([
      expect.objectContaining({
        kind: "google_oauth_client_config",
        action: "remove",
        outcome: "ok",
        clientId: null,
      }),
    ]);
  });

  test("managed deployment refuses provider removal", async () => {
    storedJson = VALID_INSTALLED;
    const app = await makeApp(capsFor, { managed: true });
    const res = await app.inject({
      method: "DELETE",
      url: "/api/integrations/google/oauth-client",
      headers: { "x-test-user-id": USER_OWNER },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: "managed_by_cloud" });
    expect(storedJson).toBe(VALID_INSTALLED);
  });
});
