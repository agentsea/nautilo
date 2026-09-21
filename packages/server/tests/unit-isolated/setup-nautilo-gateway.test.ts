import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { TransactionResult } from "@nautilo/config-guard";

const successfulTransaction: TransactionResult = {
  success: true,
  snapshot: "snap-gateway",
  applied: 1,
  skipped: 0,
  rolledBack: false,
  error: null,
  details: [{ key: "NAUTILO_MANAGED_GATEWAY_BASE_URL", action: "applied" as const }],
};

const transactionMock = mock(async (_input: unknown): Promise<TransactionResult> => successfulTransaction);
const actualConfigGuard = await import("@nautilo/config-guard");
mock.module("@nautilo/config-guard", () => ({
  ...actualConfigGuard,
  transaction: transactionMock,
}));

const getUserCapabilitiesMock = mock(
  async (_userId: string): Promise<string[]> => ["manage_server_settings"],
);
const actualTrust = await import("@nautilo/trust");
mock.module("@nautilo/trust", () => ({
  ...actualTrust,
  getUserCapabilities: getUserCapabilitiesMock,
}));

const writeSecurityAuditEventMock = mock((_path: string, _event: unknown) => undefined);
const actualSecurityAuditLog = await import("../../src/lib/security-audit-log");
mock.module("../../src/lib/security-audit-log", () => ({
  ...actualSecurityAuditLog,
  writeSecurityAuditEvent: writeSecurityAuditEventMock,
}));

import { setupRoutes } from "../../src/routes/setup";

const ADMIN_USER_ID = "22222222-1111-4111-8111-111111111111";
const MEMBER_USER_ID = "22222222-2222-4111-8111-111111111111";

describe("Nautilo Gateway setup routes", () => {
  const instances: FastifyInstance[] = [];
  let originalDeploymentMode: string | undefined;
  let originalBaseUrl: string | undefined;

  beforeEach(() => {
    originalDeploymentMode = process.env["NAUTILO_DEPLOYMENT_MODE"];
    originalBaseUrl = process.env["NAUTILO_MANAGED_GATEWAY_BASE_URL"];
    delete process.env["NAUTILO_DEPLOYMENT_MODE"];
    delete process.env["NAUTILO_MANAGED_GATEWAY_BASE_URL"];
    transactionMock.mockReset();
    transactionMock.mockImplementation(async () => successfulTransaction);
    getUserCapabilitiesMock.mockReset();
    getUserCapabilitiesMock.mockImplementation(async () => ["manage_server_settings"]);
    writeSecurityAuditEventMock.mockClear();
  });

  afterEach(async () => {
    if (originalDeploymentMode === undefined) delete process.env["NAUTILO_DEPLOYMENT_MODE"];
    else process.env["NAUTILO_DEPLOYMENT_MODE"] = originalDeploymentMode;
    if (originalBaseUrl === undefined) delete process.env["NAUTILO_MANAGED_GATEWAY_BASE_URL"];
    else process.env["NAUTILO_MANAGED_GATEWAY_BASE_URL"] = originalBaseUrl;
    await Promise.all(instances.splice(0).map((app) => app.close()));
  });

  function makeApp(sessionUserId: string | null): FastifyInstance {
    const app = Fastify({ logger: false });
    app.decorateRequest("sessionUserId", null);
    app.addHook("preHandler", async (request) => {
      request.sessionUserId = sessionUserId;
    });
    setupRoutes(app);
    instances.push(app);
    return app;
  }

  test("requires an authenticated session for reads and writes", async () => {
    const app = makeApp(null);
    const read = await app.inject({ method: "GET", url: "/api/setup/nautilo-gateway" });
    const write = await app.inject({
      method: "PUT",
      url: "/api/setup/nautilo-gateway",
      payload: { baseUrl: "https://gateway.example/v1" },
    });
    expect(read.statusCode).toBe(401);
    expect(write.statusCode).toBe(401);
    expect(transactionMock).toHaveBeenCalledTimes(0);
  });

  test("denies members without provider or server settings authority", async () => {
    getUserCapabilitiesMock.mockImplementation(async () => []);
    const app = makeApp(MEMBER_USER_ID);
    const read = await app.inject({ method: "GET", url: "/api/setup/nautilo-gateway" });
    const write = await app.inject({
      method: "PUT",
      url: "/api/setup/nautilo-gateway",
      payload: { baseUrl: "https://gateway.example/v1" },
    });
    expect(read.statusCode).toBe(403);
    expect(write.statusCode).toBe(403);
    expect(transactionMock).toHaveBeenCalledTimes(0);
  });

  test("denies cloud-managed reads and writes through the route inventory", async () => {
    process.env["NAUTILO_DEPLOYMENT_MODE"] = "cloud-managed";
    const app = makeApp(ADMIN_USER_ID);
    const read = await app.inject({ method: "GET", url: "/api/setup/nautilo-gateway" });
    const write = await app.inject({
      method: "PUT",
      url: "/api/setup/nautilo-gateway",
      payload: { baseUrl: "https://gateway.example/v1" },
    });
    expect(read.statusCode).toBe(403);
    expect(write.statusCode).toBe(403);
    expect(JSON.parse(read.body)).toEqual({ error: "managed_credentials_control_plane_owned" });
    expect(transactionMock).toHaveBeenCalledTimes(0);
  });

  test("returns the normalized current URL only to an authorized administrator", async () => {
    getUserCapabilitiesMock.mockImplementation(async () => ["manage_connection_providers"]);
    process.env["NAUTILO_MANAGED_GATEWAY_BASE_URL"] = " https://gateway.example/v1/// ";
    const response = await makeApp(ADMIN_USER_ID).inject({
      method: "GET",
      url: "/api/setup/nautilo-gateway",
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ baseUrl: "https://gateway.example/v1" });
  });

  test("rejects malformed or unsafe URLs before persistence", async () => {
    const app = makeApp(ADMIN_USER_ID);
    for (const baseUrl of [
      "http://gateway.example/v1",
      "https://user:secret@gateway.example/v1",
      "https://gateway.example/v1?tenant=one",
      "https://gateway.example/v1#fragment",
      "https://gateway.example/api",
    ]) {
      const response = await app.inject({
        method: "PUT",
        url: "/api/setup/nautilo-gateway",
        payload: { baseUrl },
      });
      expect(response.statusCode).toBe(400);
    }
    expect(transactionMock).toHaveBeenCalledTimes(0);
  });

  test("normalizes and persists an authorized update", async () => {
    getUserCapabilitiesMock.mockImplementation(async () => ["manage_connection_providers"]);
    const response = await makeApp(ADMIN_USER_ID).inject({
      method: "PUT",
      url: "/api/setup/nautilo-gateway",
      payload: { baseUrl: " https://gateway.example/v1/// " },
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ baseUrl: "https://gateway.example/v1" });
    expect(transactionMock).toHaveBeenCalledWith({
      operations: [{
        type: "set",
        key: "NAUTILO_MANAGED_GATEWAY_BASE_URL",
        value: "https://gateway.example/v1",
      }],
      healthCheck: "none",
      overwrite: true,
      reason: "Nautilo Gateway URL changed in Server admin",
      actor: "setup-spa",
    });
    expect(writeSecurityAuditEventMock).toHaveBeenCalledTimes(1);
  });

  test("reports persistence failure without claiming the URL changed", async () => {
    transactionMock.mockImplementationOnce(async () => ({
      ...successfulTransaction,
      success: false,
      applied: 0,
      error: "canonical target unavailable",
      details: [],
    }));
    const response = await makeApp(ADMIN_USER_ID).inject({
      method: "PUT",
      url: "/api/setup/nautilo-gateway",
      payload: { baseUrl: "https://gateway.example/v1" },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: "canonical target unavailable" });
    expect(writeSecurityAuditEventMock).toHaveBeenCalledTimes(0);
  });
});
