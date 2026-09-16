import { afterEach, describe, expect, test } from "bun:test";
import Fastify from "fastify";
import {
  MaintenanceDrainError,
  permissiveMaintenanceGate,
  setMaintenanceGate,
  type MaintenanceGate,
} from "@nautilo/runtime";
import { jobRoutes } from "../../src/routes/jobs";
import { AgentInvocationDeniedError } from "@nautilo/trust";

const drainingGate: MaintenanceGate = {
  async assertAcceptingNewWork() {
    throw new MaintenanceDrainError("draining");
  },
  async isAcceptingWork() {
    return false;
  },
};

afterEach(() => {
  setMaintenanceGate(permissiveMaintenanceGate);
});

describe("D420 POST /api/jobs maintenance rejection", () => {
  test("returns the typed retryable response before a background Job persists", async () => {
    setMaintenanceGate(drainingGate);
    const app = Fastify({ logger: false });
    app.decorateRequest("memoryEnvelope", null);
    app.decorateRequest("sessionUserId", null);
    app.addHook("preHandler", (request, _reply, done) => {
      (request as { sessionUserId: string }).sessionUserId =
        "11111111-1111-4111-8111-111111111111";
      done();
    });
    jobRoutes(app, { assertCanInvokeAgent: async () => undefined });
    await app.ready();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/jobs",
        payload: { task: "must not start" },
      });
      expect(response.statusCode).toBe(503);
      const body = JSON.parse(response.body) as {
        error: string;
        code: string;
        message: string;
        retryable: boolean;
        maintenanceState: string;
      };
      expect(body).toMatchObject({
        error: "maintenance_draining",
        code: "maintenance_draining",
        retryable: true,
        maintenanceState: "draining",
      });
      expect(body.message).toContain("maintenance");
    } finally {
      await app.close();
    }
  });
});

describe("M254 POST /api/jobs invocation admission", () => {
  test("returns the exact 403 before background Job creation", async () => {
    const app = Fastify({ logger: false });
    app.decorateRequest("memoryEnvelope", null);
    app.decorateRequest("sessionUserId", null);
    app.addHook("preHandler", (request, _reply, done) => {
      (request as { sessionUserId: string }).sessionUserId =
        "11111111-1111-4111-8111-111111111111";
      done();
    });
    jobRoutes(app, {
      assertCanInvokeAgent: async (input) => {
        throw new AgentInvocationDeniedError(input);
      },
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/jobs",
      payload: { task: "must not start" },
    });
    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body)).toEqual({
      error: "invoke_agents_required",
      code: "invoke_agents_required",
      capability: "invoke_agents",
    });
    await app.close();
  });
});
