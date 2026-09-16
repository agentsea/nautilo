import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import { MaintenanceTransitionError } from "@nautilo/db";
import * as operatorSecrets from "@nautilo/operator-secrets";
import type { MaintenanceCancellationResult } from "@nautilo/runtime";
import { _resetBootstrapStateCacheForTests } from "@nautilo/trust";
import { operatorMaintenanceRoutes } from "../../src/routes/operator-release";
import type { MaintenanceControllerSeam } from "../../src/routes/operator-release";

const ORIGINAL_TOKEN = process.env["NAUTILO_BOOTSTRAP_TOKEN"];
let restoreBootstrapUsedSpy: () => void = () => {};

beforeEach(() => {
  // Operator route tests model a fresh, unclaimed deployment. A retained
  // developer instance may legitimately carry `.bootstrap/.used`; isolate
  // that machine state from this route contract.
  const spy = spyOn(operatorSecrets, "isBootstrapUsed").mockImplementation(() => false);
  restoreBootstrapUsedSpy = () => spy.mockRestore();
  _resetBootstrapStateCacheForTests();
});

afterEach(() => {
  restoreBootstrapUsedSpy();
  _resetBootstrapStateCacheForTests();
  if (ORIGINAL_TOKEN === undefined) delete process.env["NAUTILO_BOOTSTRAP_TOKEN"];
  else process.env["NAUTILO_BOOTSTRAP_TOKEN"] = ORIGINAL_TOKEN;
});

const NOW = new Date("2026-07-14T12:00:00.000Z");
const LEASE = new Date("2026-07-14T12:05:00.000Z");
const HARD = new Date("2026-07-14T12:30:00.000Z");

/** Parse an inject response body as a typed record (avoids `any` propagation). */
interface MaintenanceTestBody {
  state?: unknown;
  operationId?: unknown;
  leaseExpiresAt?: unknown;
  hardExpiresAt?: unknown;
  work?: unknown;
  error?: unknown;
  code?: unknown;
  message?: unknown;
}
function parseBody(body: string): MaintenanceTestBody {
  return JSON.parse(body) as MaintenanceTestBody;
}

function snapshot(over: Partial<{
  state: "normal" | "draining" | "applying";
  operationId: string | null;
}> = {}) {
  return {
    singletonKey: "upgrade",
    state: over.state ?? "draining",
    operationId: over.operationId ?? "op-123",
    leaseExpiresAt: LEASE,
    hardExpiresAt: HARD,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

interface StubController extends MaintenanceControllerSeam {
  calls: { op: string; operationId?: string; opts?: unknown }[];
}

function makeStubController(overrides: Partial<StubController> = {}): StubController {
  const calls: StubController["calls"] = [];
  const base: StubController = {
    calls,
    async getState() {
      calls.push({ op: "getState" });
      return snapshot();
    },
    async enterDraining(opts) {
      calls.push({ op: "enterDraining", opts });
      return snapshot({ operationId: opts?.operationId ?? "op-123" });
    },
    async transitionApplying(operationId) {
      calls.push({ op: "transitionApplying", operationId });
      return snapshot({ state: "applying", operationId });
    },
    async renewLease(operationId, opts) {
      calls.push({ op: "renewLease", operationId, opts });
      return snapshot({ operationId });
    },
    async complete(operationId) {
      calls.push({ op: "complete", operationId });
      return snapshot({ state: "normal", operationId: null });
    },
    async cancel(operationId) {
      calls.push({ op: "cancel", operationId });
      return snapshot({ state: "normal", operationId: null });
    },
  };
  return { ...base, ...overrides };
}

function makeDeps(
  controller = makeStubController(),
  opts: {
    terminalize?: () => Promise<MaintenanceCancellationResult>;
  } = {},
) {
  const terminalizeCalls: Array<{ called: true }> = [];
  return {
    controller,
    jobManager: {
      getExecutableJobWorkSummary: () => ({
        runningForegroundJobs: 2,
        runningBackgroundJobs: 3,
        queuedTurns: 4,
        bufferedLanes: 5,
      }),
      terminalizeExecutableWorkForMaintenance:
        opts.terminalize ??
        (async (): Promise<MaintenanceCancellationResult> => {
          terminalizeCalls.push({ called: true });
          return {
            cancelledJobs: 0,
            cancelledTaskRuns: 0,
            droppedQueuedTurns: 0,
            droppedBufferedLanes: 0,
            terminalizedAcceptances: 0,
          };
        }),
    },
    countAcceptedWork: async () => 6,
    countActiveTaskWork: async () => ({
      runningTaskRuns: 7,
      claimedTasks: 8,
    }),
    terminalizeCalls,
  };
}

async function withApp(
  fn: (app: FastifyInstance) => Promise<void>,
  deps = makeDeps(),
): Promise<void> {
  const app: FastifyInstance = Fastify({ logger: false });
  operatorMaintenanceRoutes(app, deps);
  try {
    await fn(app);
  } finally {
    await app.close();
  }
}

describe("D420 operator maintenance API trust boundary", () => {
  test("rejects a remote caller without deployment/bootstrap authorization", async () => {
    await withApp(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/operator/maintenance/enter",
        remoteAddress: "203.0.113.10",
      });
      expect(response.statusCode).toBe(403);
    });
  });

  test("admits a loopback operator without a token", async () => {
    delete process.env["NAUTILO_BOOTSTRAP_TOKEN"];
    await withApp(async (app) => {
      const response = await app.inject({
        method: "GET",
        url: "/api/operator/maintenance/status",
        remoteAddress: "127.0.0.1",
      });
      expect(response.statusCode).toBe(200);
    });
  });

  test("admits a remote caller with the bootstrap bearer", async () => {
    process.env["NAUTILO_BOOTSTRAP_TOKEN"] = "operator-token";
    await withApp(async (app) => {
      const response = await app.inject({
        method: "GET",
        url: "/api/operator/maintenance/status",
        headers: { authorization: "Bearer operator-token" },
        remoteAddress: "203.0.113.10",
      });
      expect(response.statusCode).toBe(200);
    });
  });
});

describe("D420 operator maintenance enter/status payload-free response", () => {
  test("enter returns state, operation, expiry, and aggregate counts only", async () => {
    process.env["NAUTILO_BOOTSTRAP_TOKEN"] = "operator-token";
    const controller = makeStubController();
    await withApp(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/operator/maintenance/enter",
        headers: { authorization: "Bearer operator-token" },
        remoteAddress: "203.0.113.10",
        payload: { leaseMs: 60_000 },
      });
      expect(response.statusCode).toBe(200);
      const body = parseBody(response.body);
      expect(body).toEqual({
        state: "draining",
        operationId: "op-123",
        leaseExpiresAt: LEASE.toISOString(),
        hardExpiresAt: HARD.toISOString(),
        work: {
          runningForegroundJobs: 2,
          runningBackgroundJobs: 3,
          queuedTurns: 4,
          bufferedLanes: 5,
          acceptedWork: 6,
          runningTaskRuns: 7,
          claimedTasks: 8,
        },
      });
      // No prompt/room/lane/job/user payload leaks.
      expect(response.body).not.toContain("prompt");
      expect(response.body).not.toContain("laneKey");
      expect(response.body).not.toContain("jobId");
      expect(response.body).not.toContain("userId");
    }, makeDeps(controller));
    expect(controller.calls[0]!.op).toBe("enterDraining");
    expect(controller.calls[0]!.opts).toEqual({ leaseMs: 60_000 });
  });

  test("status returns the same payload-free shape", async () => {
    process.env["NAUTILO_BOOTSTRAP_TOKEN"] = "operator-token";
    await withApp(async (app) => {
      const response = await app.inject({
        method: "GET",
        url: "/api/operator/maintenance/status",
        headers: { authorization: "Bearer operator-token" },
        remoteAddress: "203.0.113.10",
      });
      expect(response.statusCode).toBe(200);
      const body = parseBody(response.body);
      expect(body.work).toEqual({
        runningForegroundJobs: 2,
        runningBackgroundJobs: 3,
        queuedTurns: 4,
        bufferedLanes: 5,
        acceptedWork: 6,
        runningTaskRuns: 7,
        claimedTasks: 8,
      });
      expect(Object.keys(body).sort()).toEqual(
        ["hardExpiresAt", "leaseExpiresAt", "operationId", "state", "work"].sort(),
      );
    });
  });
});

describe("D420 operator maintenance owning-operation verbs", () => {
  test("renew/applying/cancel/complete forward the operationId to the controller", async () => {
    process.env["NAUTILO_BOOTSTRAP_TOKEN"] = "operator-token";
    const controller = makeStubController();
    await withApp(async (app) => {
      const headers = { authorization: "Bearer operator-token" };
      const remote = "203.0.113.10";
      const renew = await app.inject({
        method: "POST",
        url: "/api/operator/maintenance/renew",
        headers,
        remoteAddress: remote,
        payload: { operationId: "op-xyz" },
      });
      expect(renew.statusCode).toBe(200);
      expect(parseBody(renew.body).operationId).toBe("op-xyz");

      const applying = await app.inject({
        method: "POST",
        url: "/api/operator/maintenance/applying",
        headers,
        remoteAddress: remote,
        payload: { operationId: "op-xyz" },
      });
      expect(applying.statusCode).toBe(200);
      expect(parseBody(applying.body).state).toBe("applying");

      const cancel = await app.inject({
        method: "POST",
        url: "/api/operator/maintenance/cancel",
        headers,
        remoteAddress: remote,
        payload: { operationId: "op-xyz" },
      });
      expect(cancel.statusCode).toBe(200);
      expect(parseBody(cancel.body).state).toBe("normal");

      const complete = await app.inject({
        method: "POST",
        url: "/api/operator/maintenance/complete",
        headers,
        remoteAddress: remote,
        payload: { operationId: "op-xyz" },
      });
      expect(complete.statusCode).toBe(200);
      expect(parseBody(complete.body).state).toBe("normal");
    }, makeDeps(controller));
    const ops = controller.calls.map((c) => c.op);
    expect(ops).toEqual([
      "renewLease",
      "transitionApplying",
      "cancel",
      "complete",
    ]);
    for (const c of controller.calls) expect(c.operationId).toBe("op-xyz");
  });

  test("owning verbs reject a missing operationId with 400", async () => {
    process.env["NAUTILO_BOOTSTRAP_TOKEN"] = "operator-token";
    await withApp(async (app) => {
      const headers = { authorization: "Bearer operator-token" };
      const remote = "203.0.113.10";
      for (const verb of ["renew", "applying", "cancel", "complete"]) {
        const response = await app.inject({
          method: "POST",
          url: `/api/operator/maintenance/${verb}`,
          headers,
          remoteAddress: remote,
          payload: {},
        });
        expect(response.statusCode).toBe(400);
      }
    });
  });
});

describe("D420 operator maintenance transition failures", () => {
  test("renders a 409 with the machine-readable transition code", async () => {
    process.env["NAUTILO_BOOTSTRAP_TOKEN"] = "operator-token";
    const controller = makeStubController({
      async enterDraining() {
        throw new MaintenanceTransitionError(
          "maintenance already in progress (state=draining)",
          "in_progress",
        );
      },
    });
    await withApp(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/operator/maintenance/enter",
        headers: { authorization: "Bearer operator-token" },
        remoteAddress: "203.0.113.10",
        payload: {},
      });
      expect(response.statusCode).toBe(409);
      const body = parseBody(response.body);
      expect(body).toMatchObject({
        error: "maintenance_transition",
        code: "in_progress",
      });
      expect(String(body.message)).toContain("already in progress");
    }, makeDeps(controller));
  });

  test("cross-owner renew surfaces the not_owner code", async () => {
    process.env["NAUTILO_BOOTSTRAP_TOKEN"] = "operator-token";
    const controller = makeStubController({
      async renewLease() {
        throw new MaintenanceTransitionError("not the owning operation", "not_owner");
      },
    });
    await withApp(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/operator/maintenance/renew",
        headers: { authorization: "Bearer operator-token" },
        remoteAddress: "203.0.113.10",
        payload: { operationId: "op-wrong" },
      });
      expect(response.statusCode).toBe(409);
      expect(parseBody(response.body).code).toBe("not_owner");
    }, makeDeps(controller));
  });
});

describe("D420 operator maintenance cancel-work (task 2.2.3)", () => {
  test("rejects a remote caller without deployment/bootstrap authorization", async () => {
    await withApp(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/operator/maintenance/cancel-work",
        remoteAddress: "203.0.113.10",
        payload: { operationId: "op-123" },
      });
      expect(response.statusCode).toBe(403);
    });
  });

  test("requires the owning operationId (400 when missing)", async () => {
    process.env["NAUTILO_BOOTSTRAP_TOKEN"] = "operator-token";
    await withApp(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/operator/maintenance/cancel-work",
        headers: { authorization: "Bearer operator-token" },
        remoteAddress: "203.0.113.10",
        payload: {},
      });
      expect(response.statusCode).toBe(400);
    });
  });

  test("refuses a cross-owner operation with a 409 not_owner and does not terminalize", async () => {
    process.env["NAUTILO_BOOTSTRAP_TOKEN"] = "operator-token";
    const controller = makeStubController({
      async getState() {
        return snapshot({ operationId: "op-other" });
      },
    });
    const deps = makeDeps(controller);
    await withApp(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/operator/maintenance/cancel-work",
        headers: { authorization: "Bearer operator-token" },
        remoteAddress: "203.0.113.10",
        payload: { operationId: "op-xyz" },
      });
      expect(response.statusCode).toBe(409);
      expect(parseBody(response.body).code).toBe("not_owner");
    }, deps);
    expect(deps.terminalizeCalls).toHaveLength(0);
  });

  test("refuses cancel-work when the lease is not draining (409 invalid_transition)", async () => {
    process.env["NAUTILO_BOOTSTRAP_TOKEN"] = "operator-token";
    const controller = makeStubController({
      async getState() {
        return snapshot({ state: "applying", operationId: "op-123" });
      },
    });
    const deps = makeDeps(controller);
    await withApp(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/operator/maintenance/cancel-work",
        headers: { authorization: "Bearer operator-token" },
        remoteAddress: "203.0.113.10",
        payload: { operationId: "op-123" },
      });
      expect(response.statusCode).toBe(409);
      expect(parseBody(response.body).code).toBe("invalid_transition");
    }, deps);
    expect(deps.terminalizeCalls).toHaveLength(0);
  });

  test("terminalizes executable work for the owning draining lease and returns status", async () => {
    process.env["NAUTILO_BOOTSTRAP_TOKEN"] = "operator-token";
    const controller = makeStubController();
    const deps = makeDeps(controller);
    await withApp(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/operator/maintenance/cancel-work",
        headers: { authorization: "Bearer operator-token" },
        remoteAddress: "203.0.113.10",
        payload: { operationId: "op-123" },
      });
      expect(response.statusCode).toBe(200);
      const body = parseBody(response.body);
      expect(body.state).toBe("draining");
      expect(body.operationId).toBe("op-123");
      // Payload-free aggregate counts only.
      expect(body.work).toEqual({
        runningForegroundJobs: 2,
        runningBackgroundJobs: 3,
        queuedTurns: 4,
        bufferedLanes: 5,
        acceptedWork: 6,
        runningTaskRuns: 7,
        claimedTasks: 8,
      });
    }, deps);
    expect(deps.terminalizeCalls).toHaveLength(1);
  });

  test("propagates a terminalization failure (fail closed) instead of returning status", async () => {
    process.env["NAUTILO_BOOTSTRAP_TOKEN"] = "operator-token";
    const controller = makeStubController();
    const deps = makeDeps(controller, {
      terminalize: async (): Promise<MaintenanceCancellationResult> => {
        throw new Error("ledger unavailable");
      },
    });
    await withApp(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/operator/maintenance/cancel-work",
        headers: { authorization: "Bearer operator-token" },
        remoteAddress: "203.0.113.10",
        payload: { operationId: "op-123" },
      });
      expect(response.statusCode).toBe(500);
    }, deps);
  });
});
