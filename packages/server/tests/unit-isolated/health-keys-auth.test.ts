import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";

const keysFixture = [
  { id: "ANTHROPIC_API_KEY", envVar: "ANTHROPIC_API_KEY", status: "present", masked: "sk-ant-***" },
];

const checkMock = mock(async (_opts?: unknown) => ({
  keys: keysFixture,
  summary: { hasLlm: true },
}));
const getModeReportMock = mock(() => ({ modes: [] }));

const actualConfigGuard = await import("@nautilo/config-guard");
mock.module("@nautilo/config-guard", () => ({
  ...actualConfigGuard,
  check: checkMock,
  getModeReport: getModeReportMock,
}));

const getUserCapabilitiesMock = mock(
  async (_userId: string): Promise<string[]> => ["manage_server_settings"],
);
const actualTrust = await import("@nautilo/trust");
mock.module("@nautilo/trust", () => ({
  ...actualTrust,
  getUserCapabilities: getUserCapabilitiesMock,
}));

import { healthRoutes } from "../../src/routes/health";

const ADMIN_USER_ID = "22222222-1111-4111-8111-111111111111";
const MEMBER_USER_ID = "22222222-2222-4111-8111-111111111111";

describe("GET /api/health/keys + POST /api/health/keys/validate (D445 Phase 1)", () => {
  const instances: FastifyInstance[] = [];
  let originalDeploymentMode: string | undefined;

  beforeEach(() => {
    originalDeploymentMode = process.env["NAUTILO_DEPLOYMENT_MODE"];
    delete process.env["NAUTILO_DEPLOYMENT_MODE"];
    checkMock.mockClear();
    getModeReportMock.mockClear();
    getUserCapabilitiesMock.mockImplementation(async () => [
      "manage_server_settings",
    ]);
  });

  afterEach(async () => {
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
    healthRoutes(app);
    instances.push(app);
    return app;
  }

  test("admin provider managers can inspect and validate API keys without owner authority", async () => {
    getUserCapabilitiesMock.mockImplementation(async () => ["manage_connection_providers"]);
    const app = makeApp(ADMIN_USER_ID);
    for (const method of ["GET", "POST"] as const) {
      const res = await app.inject({
        method,
        url: method === "GET" ? "/api/health/keys" : "/api/health/keys/validate",
        remoteAddress: "203.0.113.10",
      });
      expect(res.statusCode).toBe(200);
    }
    expect(checkMock).toHaveBeenCalledTimes(2);
  });

  describe("GET /api/health/keys", () => {
    test("cloud-managed fails before inspection even on loopback", async () => {
      process.env["NAUTILO_DEPLOYMENT_MODE"] = "cloud-managed";
      const res = await makeApp(ADMIN_USER_ID).inject({
        method: "GET",
        url: "/api/health/keys",
        remoteAddress: "127.0.0.1",
      });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body)).toEqual({ error: "managed_credentials_control_plane_owned" });
      expect(checkMock).toHaveBeenCalledTimes(0);
    });
    test("200 for loopback caller with no session", async () => {
      const app = makeApp(null);
      const res = await app.inject({
        method: "GET",
        url: "/api/health/keys",
        remoteAddress: "127.0.0.1",
      });
      expect(res.statusCode).toBe(200);
      expect(checkMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse(res.body) as unknown[];
      expect(Array.isArray(body)).toBe(true);
    });

    test("401 for remote unauthenticated caller", async () => {
      const app = makeApp(null);
      const res = await app.inject({
        method: "GET",
        url: "/api/health/keys",
        remoteAddress: "203.0.113.10",
      });
      expect(res.statusCode).toBe(401);
      expect(checkMock).toHaveBeenCalledTimes(0);
    });

    test("403 for remote authenticated caller without provider-management or owner capabilities", async () => {
      getUserCapabilitiesMock.mockImplementation(async () => []);
      const app = makeApp(MEMBER_USER_ID);
      const res = await app.inject({
        method: "GET",
        url: "/api/health/keys",
        remoteAddress: "203.0.113.10",
      });
      expect(res.statusCode).toBe(403);
      expect(checkMock).toHaveBeenCalledTimes(0);
    });

    test("200 for remote authenticated caller with manage_server_settings", async () => {
      const app = makeApp(ADMIN_USER_ID);
      const res = await app.inject({
        method: "GET",
        url: "/api/health/keys",
        remoteAddress: "203.0.113.10",
      });
      expect(res.statusCode).toBe(200);
      expect(checkMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("POST /api/health/keys/validate", () => {
    test("cloud-managed fails before validation even on loopback", async () => {
      process.env["NAUTILO_DEPLOYMENT_MODE"] = "cloud-managed";
      const res = await makeApp(ADMIN_USER_ID).inject({
        method: "POST",
        url: "/api/health/keys/validate",
        remoteAddress: "127.0.0.1",
      });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body)).toEqual({ error: "managed_credentials_control_plane_owned" });
      expect(checkMock).toHaveBeenCalledTimes(0);
    });
    test("200 for loopback caller with no session", async () => {
      const app = makeApp(null);
      const res = await app.inject({
        method: "POST",
        url: "/api/health/keys/validate",
        remoteAddress: "127.0.0.1",
      });
      expect(res.statusCode).toBe(200);
      expect(checkMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse(res.body) as { keys: unknown[]; summary: unknown };
      expect(body.keys).toBeDefined();
      expect(body.summary).toBeDefined();
    });

    test("401 for remote unauthenticated caller", async () => {
      const app = makeApp(null);
      const res = await app.inject({
        method: "POST",
        url: "/api/health/keys/validate",
        remoteAddress: "203.0.113.10",
      });
      expect(res.statusCode).toBe(401);
      expect(checkMock).toHaveBeenCalledTimes(0);
    });

    test("403 for remote authenticated caller without provider-management or owner capabilities", async () => {
      getUserCapabilitiesMock.mockImplementation(async () => []);
      const app = makeApp(MEMBER_USER_ID);
      const res = await app.inject({
        method: "POST",
        url: "/api/health/keys/validate",
        remoteAddress: "203.0.113.10",
      });
      expect(res.statusCode).toBe(403);
      expect(checkMock).toHaveBeenCalledTimes(0);
    });

    test("200 for remote authenticated caller with manage_server_settings", async () => {
      const app = makeApp(ADMIN_USER_ID);
      const res = await app.inject({
        method: "POST",
        url: "/api/health/keys/validate",
        remoteAddress: "203.0.113.10",
      });
      expect(res.statusCode).toBe(200);
      expect(checkMock).toHaveBeenCalledTimes(1);
    });
  });
});
