import { describe, expect, mock, test } from "bun:test";
import Fastify from "fastify";
import { memoryStatusRoutes } from "../../src/routes/memory-status";

function fixture() {
  const app = Fastify();
  app.decorateRequest("sessionUserId", null);
  app.addHook("preHandler", async (request) => {
    request.sessionUserId = typeof request.headers["x-user"] === "string" ? request.headers["x-user"] : null;
  });
  const queryStatus = mock(async (): Promise<never> => { throw new Error("private provider response"); });
  const retryFailed = mock(async () => ({ requested: 2 }));
  const requestModelRecovery = mock(async (_input: Parameters<
    Parameters<typeof memoryStatusRoutes>[1]["requestModelRecovery"]
  >[0]) => "queued" as const);
  memoryStatusRoutes(app, {
    queryStatus, retryFailed, requestModelRecovery,
    getCapabilities: async (id) => id === "reader" ? ["read_server_settings"] : id === "operator" ? ["manage_server_operations"] : [],
  });
  return { app, queryStatus, retryFailed, requestModelRecovery };
}

describe("Memory operational routes", () => {
  test("rejects unauthenticated reads and unauthorized retries before repository access", async () => {
    const { app, queryStatus, retryFailed } = fixture();
    try {
      expect((await app.inject({ url: "/api/admin/memory-status" })).statusCode).toBe(401);
      expect((await app.inject({ method: "POST", url: "/api/admin/memory-retry", headers: { "x-user": "reader" } })).statusCode).toBe(403);
      expect(queryStatus).not.toHaveBeenCalled();
      expect(retryFailed).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  test("status outages are unavailable and never expose provider content", async () => {
    const { app } = fixture();
    try {
      const result = await app.inject({ url: "/api/admin/memory-status", headers: { "x-user": "reader" } });
      expect(result.statusCode).toBe(503);
      expect(result.body).not.toContain("private provider");
    } finally { await app.close(); }
  });
  test("recovery accepts an exact, explicitly confirmed request from an operations administrator", async () => {
    const { app, requestModelRecovery, retryFailed } = fixture();
    const workId = "11111111-1111-4111-8111-111111111111";
    const headTurnId = "22222222-2222-4222-8222-222222222222";
    const request = { method: "POST", url: "/api/admin/memory-review-recovery" } as const;
    const coordinates = { workId, headTurnId };
    const payload = { ...coordinates, confirmBillableRerun: true };
    try {
      expect((await app.inject({ ...request, payload })).statusCode).toBe(401);
      expect((await app.inject({ ...request, payload, headers: { "x-user": "reader" } })).statusCode).toBe(403);
      expect((await app.inject({ ...request, payload: coordinates, headers: { "x-user": "operator" } })).statusCode).toBe(400);
      expect(requestModelRecovery).not.toHaveBeenCalled();
      const response = await app.inject({ ...request, payload, headers: { "x-user": "operator" } });
      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({ status: "queued" });
      expect(requestModelRecovery).toHaveBeenCalledTimes(1);
      const recorded = requestModelRecovery.mock.calls[0]?.[0];
      expect(recorded).toMatchObject({ ...coordinates, authorizedBy: "operator" });
      expect(recorded?.now).toBeInstanceOf(Date);
      expect(retryFailed).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  test("operations permission invokes only the safe repository retry", async () => {
    const { app, retryFailed } = fixture();
    try {
      const result = await app.inject({ method: "POST", url: "/api/admin/memory-retry", headers: { "x-user": "operator" } });
      expect(result.statusCode).toBe(200);
      expect(result.json<{ requested: number }>()).toEqual({ requested: 2 });
      expect(retryFailed).toHaveBeenCalledTimes(1);
    } finally { await app.close(); }
  });
});
