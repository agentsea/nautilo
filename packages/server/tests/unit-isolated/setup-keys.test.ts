import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";

const transactionMock = mock(async (_input: unknown) => ({
  success: true,
  snapshot: "snap-1",
  applied: 1,
  skipped: 0,
  rolledBack: false,
  error: null,
  details: [{ key: "ANTHROPIC_API_KEY", action: "applied" as const }],
}));

const writeSecurityAuditEventMock = mock((_path: string, _event: unknown) => undefined);
const actualSecurityAuditLog = await import("../../src/lib/security-audit-log");
mock.module("../../src/lib/security-audit-log", () => ({
  ...actualSecurityAuditLog,
  writeSecurityAuditEvent: writeSecurityAuditEventMock,
}));

const actualConfigGuard = await import("@nautilo/config-guard");
mock.module("@nautilo/config-guard", () => ({
  ...actualConfigGuard,
  transaction: transactionMock,
}));

const actualOperatorSecrets = await import("@nautilo/operator-secrets");
mock.module("@nautilo/operator-secrets", () => ({
  ...actualOperatorSecrets,
  // This suite models a fresh cloud deployment. Do not let a retained local
  // developer instance's durable bootstrap-retirement marker alter it.
  isBootstrapUsed: () => false,
}));

const getUserCapabilitiesMock = mock(
  async (_userId: string): Promise<string[]> => ["manage_server_settings"],
);
const actualTrust = await import("@nautilo/trust");
mock.module("@nautilo/trust", () => ({
  ...actualTrust,
  getUserCapabilities: getUserCapabilitiesMock,
}));

import { setupRoutes } from "../../src/routes/setup";
import { setRelayRegistry } from "@nautilo/agent";

const ADMIN_USER_ID = "22222222-1111-4111-8111-111111111111";
const MEMBER_USER_ID = "22222222-2222-4111-8111-111111111111";
const SECRET_VALUE = "sk-ant-supersecret-d445-do-not-echo";

describe("POST /api/setup/keys (D445 Phase 1)", () => {
  const instances: FastifyInstance[] = [];
  let originalBootstrapToken: string | undefined;
  let originalDeploymentMode: string | undefined;

  beforeEach(() => {
    setRelayRegistry(null);
    actualTrust._resetBootstrapStateCacheForTests();
    originalBootstrapToken = process.env["NAUTILO_BOOTSTRAP_TOKEN"];
    originalDeploymentMode = process.env["NAUTILO_DEPLOYMENT_MODE"];
    delete process.env["NAUTILO_BOOTSTRAP_TOKEN"];
    delete process.env["NAUTILO_DEPLOYMENT_MODE"];
    transactionMock.mockClear();
    writeSecurityAuditEventMock.mockClear();
    getUserCapabilitiesMock.mockImplementation(async () => [
      "manage_server_settings",
    ]);
  });

  afterEach(async () => {
    setRelayRegistry(null);
    actualTrust._resetBootstrapStateCacheForTests();
    if (originalBootstrapToken === undefined) {
      delete process.env["NAUTILO_BOOTSTRAP_TOKEN"];
    } else {
      process.env["NAUTILO_BOOTSTRAP_TOKEN"] = originalBootstrapToken;
    }
    if (originalDeploymentMode === undefined) delete process.env["NAUTILO_DEPLOYMENT_MODE"];
    else process.env["NAUTILO_DEPLOYMENT_MODE"] = originalDeploymentMode;
    await Promise.all(instances.splice(0).map((app) => app.close()));
  });

  function makeApp(sessionUserId: string | null = null): FastifyInstance {
    const app = Fastify({ logger: false });
    app.decorateRequest("sessionUserId", null);
    app.addHook("preHandler", async (request) => {
      request.sessionUserId = sessionUserId;
    });
    setupRoutes(app);
    instances.push(app);
    return app;
  }

  function keysPayload() {
    return {
      keys: { ANTHROPIC_API_KEY: SECRET_VALUE },
      overwrite: true,
    };
  }

  test("401 when remote, unauthenticated, no bootstrap token", async () => {
    const app = makeApp(null);
    const res = await app.inject({
      method: "POST",
      url: "/api/setup/keys",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify(keysPayload()),
      remoteAddress: "203.0.113.10",
    });
    expect(res.statusCode).toBe(401);
    expect(transactionMock).toHaveBeenCalledTimes(0);
    expect(res.body).not.toContain(SECRET_VALUE);
  });

  test("cloud-managed rejects key writes before parsing or authority checks", async () => {
    process.env["NAUTILO_DEPLOYMENT_MODE"] = "cloud-managed";
    const res = await makeApp(null).inject({
      method: "POST",
      url: "/api/setup/keys",
      payload: { keys: SECRET_VALUE },
      remoteAddress: "127.0.0.1",
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: "managed_credentials_control_plane_owned" });
    expect(transactionMock).toHaveBeenCalledTimes(0);
    expect(res.body).not.toContain(SECRET_VALUE);
  });

  test("403 when remote, authenticated, lacks provider-management and owner capabilities", async () => {
    getUserCapabilitiesMock.mockImplementation(async () => []);
    const app = makeApp(MEMBER_USER_ID);
    const res = await app.inject({
      method: "POST",
      url: "/api/setup/keys",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify(keysPayload()),
      remoteAddress: "203.0.113.10",
    });
    expect(res.statusCode).toBe(403);
    expect(transactionMock).toHaveBeenCalledTimes(0);
    expect(res.body).not.toContain(SECRET_VALUE);
  });

  test("200 when remote, authenticated, holds manage_server_settings", async () => {
    const app = makeApp(ADMIN_USER_ID);
    const res = await app.inject({
      method: "POST",
      url: "/api/setup/keys",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify(keysPayload()),
      remoteAddress: "203.0.113.10",
    });
    expect(res.statusCode).toBe(200);
    expect(transactionMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(res.body) as { success: boolean };
    expect(body.success).toBe(true);
    // The submitted secret must never be echoed back in the response.
    expect(res.body).not.toContain(SECRET_VALUE);
  });

  test("admin provider managers can save keys without owner settings authority", async () => {
    getUserCapabilitiesMock.mockImplementation(async () => ["manage_connection_providers"]);
    const res = await makeApp(ADMIN_USER_ID).inject({
      method: "POST", url: "/api/setup/keys",
      payload: keysPayload(), remoteAddress: "203.0.113.10",
    });
    expect(res.statusCode).toBe(200);
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(res.body).not.toContain(SECRET_VALUE);
  });

  test("provider management cannot write deployment or identity configuration", async () => {
    getUserCapabilitiesMock.mockImplementation(async () => ["manage_connection_providers"]);
    for (const key of ["NAUTILO_DEPLOYMENT_MODE", "LOGTO_APP_SECRET", "UNKNOWN_API_KEY"]) {
      const res = await makeApp(ADMIN_USER_ID).inject({
        method: "POST", url: "/api/setup/keys",
        payload: { keys: { ANTHROPIC_API_KEY: SECRET_VALUE, [key]: SECRET_VALUE } },
        remoteAddress: "203.0.113.10",
      });
      expect(res.statusCode).toBe(400);
      expect(transactionMock).toHaveBeenCalledTimes(0);
      expect(res.body).not.toContain(SECRET_VALUE);
    }
  });

  test("200 for loopback caller with no session and no bootstrap token", async () => {
    const app = makeApp(null);
    const res = await app.inject({
      method: "POST",
      url: "/api/setup/keys",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify(keysPayload()),
      remoteAddress: "127.0.0.1",
    });
    expect(res.statusCode).toBe(200);
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(res.body).not.toContain(SECRET_VALUE);
  });

  test("200 for remote bootstrap-token bearer (cloud-deploy path), no session", async () => {
    process.env["NAUTILO_BOOTSTRAP_TOKEN"] = "bootstraptoken-d445";
    const app = makeApp(null);
    const res = await app.inject({
      method: "POST",
      url: "/api/setup/keys",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer bootstraptoken-d445",
      },
      payload: JSON.stringify(keysPayload()),
      remoteAddress: "203.0.113.10",
    });
    expect(res.statusCode).toBe(200);
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(res.body).not.toContain(SECRET_VALUE);
    // The bootstrap token itself must not leak into the response body.
    expect(res.body).not.toContain("bootstraptoken-d445");
  });

  test("401 for remote bearer that is neither bootstrap nor a session", async () => {
    process.env["NAUTILO_BOOTSTRAP_TOKEN"] = "bootstraptoken-d445";
    const app = makeApp(null);
    const res = await app.inject({
      method: "POST",
      url: "/api/setup/keys",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer not-the-bootstrap-token",
      },
      payload: JSON.stringify(keysPayload()),
      remoteAddress: "203.0.113.10",
    });
    expect(res.statusCode).toBe(401);
    expect(transactionMock).toHaveBeenCalledTimes(0);
    expect(res.body).not.toContain(SECRET_VALUE);
  });

  test("400 on invalid JSON body shape (loopback)", async () => {
    const app = makeApp(null);
    const res = await app.inject({
      method: "POST",
      url: "/api/setup/keys",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ keys: "not-a-record" }),
      remoteAddress: "127.0.0.1",
    });
    expect(res.statusCode).toBe(400);
    expect(transactionMock).toHaveBeenCalledTimes(0);
  });

  test("persists the bounded web-research provider for an authorized administrator", async () => {
    getUserCapabilitiesMock.mockImplementation(async () => ["manage_server_operations"]);
    setRelayRegistry({
      findByCapabilityForUser: (capability: string, userId: string) =>
        capability === "canResearchWeb" && userId === ADMIN_USER_ID ? ["desktop-1"] : [],
      getCapabilities: () => ({
        profile: "desktop-agent",
        canResearchWeb: true,
        canSearchResearchWeb: true,
      }),
      getProtocolVersion: () => 13,
    } as never);
    const app = makeApp(ADMIN_USER_ID);
    const res = await app.inject({
      method: "PUT",
      url: "/api/setup/research-provider",
      payload: { provider: "duckduckgo_html" },
      remoteAddress: "203.0.113.10",
    });
    expect(res.statusCode).toBe(200);
    expect(transactionMock).toHaveBeenCalledWith({
      operations: [{ type: "set", key: "NAUTILO_SEARCH_PROVIDER", value: "duckduckgo_html" }],
      healthCheck: "none",
      overwrite: true,
      reason: "Web research provider changed in Server admin",
      actor: "setup-spa",
    });
    expect(JSON.parse(res.body)).toMatchObject({
      provider: "duckduckgo_html",
    });
    expect(JSON.parse(res.body)).not.toHaveProperty("desktopReaderAvailable");
    expect(writeSecurityAuditEventMock).toHaveBeenCalledTimes(1);
    const [, auditEvent] = writeSecurityAuditEventMock.mock.calls[0]!;
    expect(auditEvent).toMatchObject({
      kind: "server_research_provider_changed",
      actorId: ADMIN_USER_ID,
      changes: {
        provider: { after: "duckduckgo_html" },
      },
    });
    expect(JSON.stringify(auditEvent)).not.toContain("TAVILY_API_KEY");
  });

  test("separates caller research status from server-wide provider policy", async () => {
    getUserCapabilitiesMock.mockImplementation(async () => ["use_research_tools"]);
    const app = makeApp(MEMBER_USER_ID);
    const policy = await app.inject({ method: "GET", url: "/api/setup/research-provider" });
    expect(policy.statusCode).toBe(403);
    const status = await app.inject({ method: "GET", url: "/api/setup/research-status" });
    expect(status.statusCode).toBe(200);
    expect(JSON.parse(status.body)).toEqual({
      desktopReaderAvailable: false,
      keylessSearchAvailable: false,
    });
    const put = await app.inject({
      method: "PUT",
      url: "/api/setup/research-provider",
      payload: { provider: "duckduckgo_html" },
    });
    expect(put.statusCode).toBe(403);
  });

  test("allows server-settings readers to inspect policy without personal research entitlement", async () => {
    getUserCapabilitiesMock.mockImplementation(async () => ["read_server_settings"]);
    const app = makeApp(ADMIN_USER_ID);
    const response = await app.inject({ method: "GET", url: "/api/setup/research-provider" });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ provider: "auto" });
    expect(JSON.parse(response.body)).not.toHaveProperty("desktopReaderAvailable");
  });

  test("denies research status without use_research_tools", async () => {
    getUserCapabilitiesMock.mockImplementation(async () => []);
    for (const role of ["owner", "admin", "member"] as const) {
      const app = makeApp(`${role}-user`);
      const response = await app.inject({ method: "GET", url: "/api/setup/research-status" });
      expect(response.statusCode).toBe(403);
      expect(JSON.parse(response.body)).toEqual({ error: "research tools required" });
    }
  });

  test("rejects legacy/internal provider values and callers below Admin", async () => {
    getUserCapabilitiesMock.mockImplementation(async () => ["manage_server_operations"]);
    const admin = makeApp(ADMIN_USER_ID);
    const invalid = await admin.inject({ method: "PUT", url: "/api/setup/research-provider", payload: { provider: "tavily" } });
    expect(invalid.statusCode).toBe(400);
    getUserCapabilitiesMock.mockImplementation(async () => []);
    const member = makeApp(MEMBER_USER_ID);
    const forbidden = await member.inject({ method: "GET", url: "/api/setup/research-provider" });
    expect(forbidden.statusCode).toBe(403);
  });
});
