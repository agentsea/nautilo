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
  memoryStatusRoutes(app, {
    queryStatus, retryFailed,
    getCapabilities: async (id) => id === "reader" ? ["read_server_settings"] : id === "operator" ? ["manage_server_operations"] : [],
  });
  return { app, queryStatus, retryFailed };
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
